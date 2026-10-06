//! In-process integration test for the inbound E2E dispatch boundary. This
//! drives the REAL `open_inbound_terminal` gate — the single inbound decrypt
//! site `handle_peer_message` calls — with a browser-initiator-sealed frame,
//! proving a terminal frame decrypts exactly where the daemon dispatches it.

use super::*;
use connection::{InFlightRebind, PeerTransport, RebindState};
use network::input_record::build;
use network::peer::DeliveryMode;

/// Establishes a `(browser_initiator, daemon_responder)` transport pair via
/// the public Noise handshake API — the same `new_responder` /
/// `into_transport` calls the live `handle_session_auth` / `handle_noise_final`
/// make — and installs the responder into a fresh authenticated peer.
pub(super) fn authenticated_e2e_peer(peer_id: &str) -> (PeerDisplayState, e2e::NoiseTransport) {
    let psk =
        e2e::test_psk_from_hex("1111111111111111111111111111111111111111111111111111111111111111")
            .unwrap();
    let prologue = e2e::derive_prologue("sess-dispatch", peer_id, &[0x42; 64]);
    let (browser_static, _) = e2e::generate_static_keypair().unwrap();
    let (daemon_static, _) = e2e::generate_static_keypair().unwrap();
    let mut init = e2e::NoiseHandshake::new_initiator(&browser_static, &psk, &prologue).unwrap();
    let mut resp = e2e::NoiseHandshake::new_responder(&daemon_static, &psk, &prologue).unwrap();
    resp.read_message(&init.write_message(b"").unwrap())
        .unwrap();
    init.read_message(&resp.write_message(b"").unwrap())
        .unwrap();
    resp.read_message(&init.write_message(b"").unwrap())
        .unwrap();

    let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(resp.into_transport().unwrap());
    (peer, init.into_transport().unwrap())
}

fn rebind_handshake_peer(
    peer_id: &str,
) -> (
    PeerDisplayState,
    e2e::NoiseTransport,
    e2e::NoiseTransport,
    Vec<u8>,
    [u8; 32],
) {
    let (mut peer, incumbent_browser) = authenticated_e2e_peer(peer_id);
    let lineage = [0x1du8; merkur_e2e::SESSION_REBIND_SECRET_BYTES];
    let chain = [0x5cu8; merkur_e2e::SESSION_REBIND_SECRET_BYTES];
    let request = e2e::build_rebind_request_transcript(
        "session-rebind",
        peer_id,
        "daemon-rebind",
        0,
        &lineage,
        &[0x71; 32],
        &[0x33; merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES],
    )
    .expect("request transcript");
    let response = e2e::build_rebind_response_transcript(
        &request,
        &[0x55; 32],
        &[0x44; merkur_e2e::ML_KEM_CIPHERTEXT_BYTES],
        1,
    )
    .expect("response transcript");
    let successor =
        e2e::derive_rebind_secrets(&chain, &[0x22; 32], &response).expect("successor secrets");
    let prologue = e2e::derive_prologue("session-rebind", "daemon-rebind", &[0x42; 64]);
    let (browser_static, _) = e2e::generate_static_keypair().expect("browser static");
    let (daemon_static, _) = e2e::generate_static_keypair().expect("daemon static");
    let (pending_browser, msg1) =
        e2e::PendingNoiseInitiator::start(&browser_static, &prologue).expect("pending browser");
    let (pending_daemon, msg2) =
        merkur_e2e::PendingNoiseResponder::start(&daemon_static, &prologue, &msg1)
            .expect("pending daemon");
    let successor = successor
        .bind_noise(pending_daemon.checkpoint(), &response)
        .unwrap();
    let successor_upgrade = *successor.direct_upgrade_secret();
    let psk = *successor.noise_psk();
    let pending_daemon = pending_daemon.install_psk(&psk).expect("daemon PSK");
    let mut successor_browser = pending_browser
        .read_authenticated_msg2(&msg2)
        .expect("browser message 2")
        .install_psk(&psk)
        .expect("browser PSK");
    let msg3 = successor_browser
        .write_message(&[])
        .expect("browser message 3");
    let successor_browser = successor_browser
        .into_transport()
        .expect("successor browser transport");

    peer.signal_session_id = "session-rebind".to_string();
    peer.paths.webtransport.available = true;
    peer.auth_timeout_at_ms = None;
    peer.upgrade_secret = Some([0xa5; 32]);
    peer.noise_handshake = Some(connection::PendingNoiseHandshake::new(pending_daemon));
    peer.rebind = Some(RebindState {
        secret: chain,
        counter: 0,
        lineage_digest: lineage,
        genesis_at_ms: 0.0,
        authorization: crate::session::authorization_epoch::AuthorizationEpoch::new(
            u64::MAX,
            [0; 64],
            0,
            0.0,
        ),
        in_flight: Some(InFlightRebind {
            candidate: None,
            request_digest: [0x99; 64],
            daemon_nonce: [0x55; 32],
            ciphertext: Box::new([0x44; merkur_e2e::ML_KEM_CIPHERTEXT_BYTES]),
            next_expected_input_seq: 1,
            successor,
            noise_msg2: msg2,
            issued_at_ms: 10.0,
            pending_response: None,
        }),
        pending_refusal: None,
    });
    (
        peer,
        incumbent_browser,
        successor_browser,
        msg3,
        successor_upgrade,
    )
}

#[tokio::test]
async fn committed_rebind_waits_for_data_without_reopening_a_carrier_gap() {
    let peer_id = "browser-rebind-rendezvous";
    let (mut peer, mut incumbent, mut successor, msg3, _) = rebind_handshake_peer(peer_id);
    peer.display_cache.resize(2, 1);
    peer.display_cache.initialized = true;
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);
    let (event_tx, _event_output) = crate::ipc::events::test_event_sink();
    let mut telemetry = session::rebind_flow::RebindTelemetry::new(event_tx.clone());
    let network = Arc::new(RwLock::new(NetworkState::new()));
    let (sender, _receiver) = mpsc::unbounded_channel();
    let signaling = Arc::new(edge_tunnel::EdgeTunnel::new_capture(sender));
    network::register_edge_signaling(&network, peer_id, signaling).await;
    assert!(
        handle_noise_final(
            peer_id,
            &noise_final_envelope(&peers[peer_id], &msg3),
            &mut peers,
            &None,
            &network,
            &mut telemetry,
            25.0,
            None,
        )
        .await
        .is_some()
    );
    // A delayed predecessor control frame cannot consume the successor's
    // receive counter. Both seal their first frame at the same counter.
    let lane = e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let stale = incumbent.seal_stream(lane, b"predecessor").unwrap();
    let fresh = successor.seal_stream(lane, b"successor").unwrap();
    let mut scratch = Vec::new();
    let mut message = pty_message(peer_id, stale, DeliveryMode::Stream);
    message.channel_id = CHANNEL_CTRL;
    assert!(matches!(
        open_inbound_terminal(peers.get_mut(peer_id).unwrap(), &mut message, &mut scratch),
        OpenOutcome::Drop
    ));
    message.payload = fresh.into();
    assert!(matches!(
        open_inbound_terminal(peers.get_mut(peer_id).unwrap(), &mut message, &mut scratch),
        OpenOutcome::Opened(9)
    ));
    assert_eq!(&scratch[..9], b"successor");
    let mut pending = HashMap::new();
    let mut parked = ParkedPeers::new();
    for _ in 0..2 {
        let evicted = heartbeat_tick(
            &mut peers,
            &mut pending,
            &mut parked,
            &None,
            &network,
            &event_tx,
            &mut telemetry,
            &[],
            Instant::now(),
        )
        .await;
        assert!(evicted.is_empty());
        assert!(peers[peer_id].edge_rebind.is_none());
        assert!(!peers[peer_id].has_display_counterpart());
    }
    // A missing signaling owner is a real departure, even before data arrived.
    network.write().await.edge_signaling.remove(peer_id);
    heartbeat_tick(
        &mut peers,
        &mut pending,
        &mut parked,
        &None,
        &network,
        &event_tx,
        &mut telemetry,
        &[],
        Instant::now(),
    )
    .await;
    assert!(peers[peer_id].edge_rebind.is_some());
}

fn noise_final_envelope(peer: &PeerDisplayState, msg3: &[u8]) -> ClientSignal {
    use merkur_wire::signaling::{NoiseFinal, RebindFinal};
    let data = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(msg3);
    if let Some(flight) = peer.rebind.as_ref().and_then(|r| r.in_flight.as_ref()) {
        let mac = merkur_e2e::compute_rebind_final_mac(
            flight.successor.rebind_secret(),
            &flight.request_digest,
            msg3,
        )
        .unwrap();
        ClientSignal::RebindFinal(RebindFinal {
            data,
            mac: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac),
        })
    } else {
        ClientSignal::NoiseFinal(NoiseFinal { data })
    }
}

#[tokio::test]
async fn forged_final_preserves_the_responder_and_expiry_retires_it() {
    let peer_id = "fenced-final";
    let (peer, _, _, msg3, _) = rebind_handshake_peer(peer_id);
    let final_frame = noise_final_envelope(&peer, &msg3);
    let mut forged = final_frame.clone();
    let ClientSignal::RebindFinal(forged_final) = &mut forged else {
        panic!("a rebind in flight finishes with rebind_final");
    };
    forged_final.mac = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0; 64]);
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);
    let (tx, _output) = crate::ipc::events::test_event_sink();
    let mut telemetry = session::rebind_flow::RebindTelemetry::new(tx);
    let network = Arc::new(RwLock::new(NetworkState::new()));
    assert!(
        handle_noise_final(
            peer_id,
            &forged,
            &mut peers,
            &None,
            &network,
            &mut telemetry,
            20.0,
            None
        )
        .await
        .is_none()
    );
    assert!(peers[peer_id].noise_handshake.is_some());
    session::rebind_flow::expire_stale_rebind_attempts(
        &mut peers,
        &mut telemetry,
        10.0 + session::policy::SessionPolicy::session_auth_timeout_ms(),
    );
    assert!(peers[peer_id].noise_handshake.is_none());
    assert!(
        handle_noise_final(
            peer_id,
            &final_frame,
            &mut peers,
            &None,
            &network,
            &mut telemetry,
            30_000.0,
            None
        )
        .await
        .is_none()
    );
    assert_eq!(peers[peer_id].rebind.as_ref().unwrap().counter, 0);
    assert!(peers[peer_id].noise.is_some());
}

#[tokio::test]
async fn uncertain_commit_reconciles_both_outcomes_without_a_spent_secret() {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use merkur_wire::signaling::SessionRebindReconcile;
    use session::reconcile_flow::reconcile;
    for committed in [false, true] {
        let peer_id = "reconcile-browser";
        let (peer, _, _, msg3, _) = rebind_handshake_peer(peer_id);
        let final_frame = noise_final_envelope(&peer, &msg3);
        let r = peer.rebind.as_ref().unwrap();
        let next_secret = *r.in_flight.as_ref().unwrap().successor.rebind_secret();
        let transcript = merkur_e2e::build_rebind_reconciliation(
            "session-rebind",
            peer_id,
            "daemon-rebind",
            &r.lineage_digest,
            0,
            &[0x99; 64],
            &[0x77; 32],
        )
        .unwrap();
        let current_mac =
            merkur_e2e::compute_rebind_reconciliation_mac(&r.secret, &transcript).unwrap();
        let next_mac =
            merkur_e2e::compute_rebind_reconciliation_mac(&next_secret, &transcript).unwrap();
        let request = SessionRebindReconcile {
            session_id: "session-rebind".into(),
            browser_node_id: peer_id.into(),
            rebind_counter: 0,
            client_nonce: B64.encode([0x77; 32]),
            attempt_digest: B64.encode([0x99; 64]),
            mac: B64.encode(current_mac),
            successor_mac: B64.encode(next_mac),
        };
        let mut peers = PeerMap::from([(peer_id.into(), peer)]);
        let (tx, _output) = crate::ipc::events::test_event_sink();
        let mut telemetry = session::rebind_flow::RebindTelemetry::new(tx);
        let network = Arc::new(RwLock::new(NetworkState::new()));
        if committed {
            assert!(
                handle_noise_final(
                    peer_id,
                    &final_frame,
                    &mut peers,
                    &None,
                    &network,
                    &mut telemetry,
                    20.0,
                    None
                )
                .await
                .is_some()
            );
        }
        let (tx, mut answers) = mpsc::unbounded_channel();
        network::register_edge_signaling(
            &network,
            peer_id,
            Arc::new(edge_tunnel::EdgeTunnel::new_capture(tx)),
        )
        .await;
        let mut forged = request.clone();
        *if committed {
            &mut forged.successor_mac
        } else {
            &mut forged.mac
        } = B64.encode([0; 64]);
        reconcile(
            peer_id,
            "daemon-rebind",
            &forged,
            &mut peers,
            &network,
            None,
        )
        .await;
        assert!(answers.try_recv().is_err());
        assert_eq!(peers[peer_id].noise_handshake.is_some(), !committed);
        for _ in 0..2 {
            reconcile(
                peer_id,
                "daemon-rebind",
                &request,
                &mut peers,
                &network,
                None,
            )
            .await;
            let (_, bytes) = answers.try_recv().unwrap();
            let answer: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            let counter = u64::from(committed);
            assert_eq!(answer["rebind_counter"], counter);
            let secret = if committed { next_secret } else { [0x5c; 64] };
            merkur_e2e::verify_rebind_reconciliation_response_mac(
                &secret,
                &transcript,
                counter,
                &decode_canonical_array::<64>(answer["mac"].as_str().unwrap()).unwrap(),
            )
            .unwrap();
        }
        assert!(peers[peer_id].noise_handshake.is_none());
        assert!(peers[peer_id].noise.is_some());
        assert_eq!(
            peers[peer_id].rebind.as_ref().unwrap().counter,
            u64::from(committed)
        );
        assert!(
            handle_noise_final(
                peer_id,
                &final_frame,
                &mut peers,
                &None,
                &network,
                &mut telemetry,
                30.0,
                None
            )
            .await
            .is_none()
        );
    }
}

#[tokio::test]
async fn failed_rebind_final_leaves_the_incumbent_session_and_direct_path_usable() {
    let peer_id = "browser-rebind-failure";
    let (peer, mut incumbent_browser, mut msg3, predecessor_upgrade) = {
        let (peer, browser, _successor_browser, msg3, _successor_upgrade) =
            rebind_handshake_peer(peer_id);
        let predecessor_upgrade = peer.upgrade_secret.expect("predecessor upgrade secret");
        (peer, browser, msg3, predecessor_upgrade)
    };
    msg3[0] ^= 0x80;
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);
    let (event_tx, _event_output) = crate::ipc::events::test_event_sink();
    let mut telemetry = session::rebind_flow::RebindTelemetry::new(event_tx);

    let accepted = handle_noise_final(
        peer_id,
        &noise_final_envelope(&peers[peer_id], &msg3),
        &mut peers,
        &None,
        &Arc::new(RwLock::new(NetworkState::new())),
        &mut telemetry,
        20.0,
        None,
    )
    .await;
    assert!(accepted.is_none());

    let peer = peers.get_mut(peer_id).expect("peer survives");
    assert!(
        peer.paths.webtransport.available,
        "direct incumbent survives"
    );
    assert_eq!(peer.upgrade_secret, Some(predecessor_upgrade));
    assert_eq!(peer.rebind.as_ref().expect("lineage").counter, 0);
    assert!(peer.auth_timeout_at_ms.is_none());
    let plaintext = b"incumbent-after-failed-rebind";
    let sealed = incumbent_browser
        .seal_stream(e2e::lane_for_channel(CHANNEL_PTY).unwrap(), plaintext)
        .expect("incumbent browser seals");
    assert_eq!(
        peer.noise
            .as_mut()
            .expect("incumbent daemon transport")
            .open_stream(e2e::lane_for_channel(CHANNEL_PTY).unwrap(), &sealed)
            .expect("incumbent daemon opens"),
        plaintext
    );
}

#[tokio::test]
async fn successful_rebind_retires_direct_commits_and_sends_a_manifest_for_the_new_carrier() {
    let peer_id = "browser-rebind-success";
    let (mut peer, _incumbent_browser, mut successor_browser, msg3, successor_upgrade) =
        rebind_handshake_peer(peer_id);
    let (candidate, mut proof_rx) = edge_candidate::CandidateReply::test_pair([1; 32]);
    peer.rebind
        .as_mut()
        .unwrap()
        .in_flight
        .as_mut()
        .unwrap()
        .candidate = Some(Arc::downgrade(&candidate));
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);
    let (event_tx, _event_output) = crate::ipc::events::test_event_sink();
    let mut telemetry = session::rebind_flow::RebindTelemetry::new(event_tx);
    let wt_state = Some(Arc::new(RwLock::new(WebTransportState::new(
        webtransport::CertState {
            cert_hash: [7; 32],
            created_at: Instant::now(),
            valid_for: Duration::from_secs(60),
        },
        44_000,
        vec![webtransport::AddressCandidate {
            addr: "198.51.100.7".to_string(),
            port: 44_000,
            kind: webtransport::CandidateFlavor::Srflx,
        }],
        webtransport::pairing::NatSignature {
            public_ip: Some("198.51.100.7".to_string()),
            nat_type: webtransport::pairing::NatTypeLabel::EndpointIndependent,
            hairpin: false,
        },
        webtransport::stun::NatMapping::EndpointIndependent,
        Some("198.51.100.7".parse().expect("daemon reflexive address")),
    ))));
    let (signaling_tx, mut signaling_rx) = mpsc::unbounded_channel();
    let signaling_tunnel = Arc::new(edge_tunnel::EdgeTunnel::new_capture(signaling_tx));
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    network::register_edge_signaling(&network_state, peer_id, signaling_tunnel).await;

    // Even identical routing bytes on another stream cannot consume this
    // candidate's responder or publish its successor.
    let (other, _other_rx) = edge_candidate::CandidateReply::test_pair([1; 32]);
    assert!(
        handle_noise_final(
            peer_id,
            &noise_final_envelope(&peers[peer_id], &msg3),
            &mut peers,
            &wt_state,
            &network_state,
            &mut telemetry,
            24.0,
            Some(&other),
        )
        .await
        .is_none()
    );
    assert!(peers[peer_id].noise_handshake.is_some());
    assert_eq!(peers[peer_id].rebind.as_ref().unwrap().counter, 0);

    let accepted = handle_noise_final(
        peer_id,
        &noise_final_envelope(&peers[peer_id], &msg3),
        &mut peers,
        &wt_state,
        &network_state,
        &mut telemetry,
        25.0,
        Some(&candidate),
    )
    .await;
    assert!(accepted.is_some());

    let peer = peers.get_mut(peer_id).expect("peer survives");
    assert!(
        !peer.paths.webtransport.available,
        "predecessor direct retired"
    );
    assert!(peer.noise.is_some(), "successor Noise installed");
    assert!(peer.noise_handshake.is_none());
    assert_eq!(peer.upgrade_secret, Some(successor_upgrade));
    assert_eq!(peer.rebind.as_ref().expect("lineage").counter, 1);
    assert!(peer.rebind.as_ref().expect("lineage").in_flight.is_none());
    let plaintext = b"successor-after-commit";
    let sealed = successor_browser
        .seal_stream(e2e::lane_for_channel(CHANNEL_PTY).unwrap(), plaintext)
        .expect("successor browser seals");
    assert_eq!(
        peer.noise
            .as_mut()
            .expect("successor daemon transport")
            .open_stream(e2e::lane_for_channel(CHANNEL_PTY).unwrap(), &sealed)
            .expect("successor daemon opens"),
        plaintext
    );

    assert!(
        signaling_rx.try_recv().is_err(),
        "successor manifest never leaks onto the incumbent route"
    );
    let (selected, manifest_bytes) = proof_rx
        .recv()
        .await
        .expect("successful rebind emits a direct manifest");
    assert!(!selected, "only the commit ACK selects the route");
    let manifest: serde_json::Value =
        serde_json::from_slice(&manifest_bytes).expect("valid direct manifest JSON");
    assert_eq!(manifest["type"], "webtransport_manifest");
    assert!(
        matches!(
            merkur_wire::signaling::DaemonSignal::parse(&manifest_bytes),
            Some(merkur_wire::signaling::DaemonSignal::WebtransportManifest { .. })
        ),
        "the manifest parses exactly as the client core reads it: {manifest}"
    );
    assert_eq!(
        manifest["browser_address"],
        candidate.browser_address.to_string(),
        "the manifest is built for the network the committed carrier proved"
    );
    assert_eq!(
        peer.browser_address,
        Some(candidate.browser_address),
        "the committed carrier's address becomes the peer's"
    );
    assert!(
        manifest["candidates"]
            .as_array()
            .is_some_and(|candidates| !candidates.is_empty()),
        "successor manifest carries a dialable candidate"
    );
}

fn pty_message(peer_id: &str, sealed: Vec<u8>, delivery: DeliveryMode) -> PeerMessage {
    PeerMessage {
        input_permit: None,
        peer_node_id: std::sync::Arc::from(peer_id),
        channel_id: CHANNEL_PTY,
        payload: bytes::Bytes::from(sealed),
        via_transport: PeerTransport::Edge,
        delivery,
        connection_id: 0,
        edge_ingress: None,
    }
}

#[tokio::test]
async fn noise_final_releases_overtaking_ciphertext_without_copying_or_losing_credit() {
    for rebind in [false, true] {
        let peer_id = "early-noise";
        let (mut peer, mut incumbent, mut browser, msg3, _) = rebind_handshake_peer(peer_id);
        if !rebind {
            peer.noise = None;
            peer.rebind = None;
        }
        let mut peers = PeerMap::from([(peer_id.into(), peer)]);
        let mut scratch = Vec::new();
        // In the rebind case, make successor counter zero collide with a
        // consumed incumbent counter: this must survive Replay, not just Auth.
        if rebind {
            let sealed = incumbent
                .seal_stream(e2e::lane_for_channel(CHANNEL_CTRL).unwrap(), b"old")
                .unwrap();
            let mut old = pty_message(peer_id, sealed, DeliveryMode::Stream);
            old.channel_id = CHANNEL_CTRL;
            old.via_transport = PeerTransport::WebTransport;
            assert!(matches!(
                open_inbound_terminal(peers.get_mut(peer_id).unwrap(), &mut old, &mut scratch),
                OpenOutcome::Opened(3)
            ));
        }
        let credit = Arc::new(tokio::sync::Semaphore::new(1));
        let mut pointers = Vec::new();
        for (channel, payload) in [
            (CHANNEL_CTRL, b"enable".as_slice()),
            (CHANNEL_CTRL, b"probe".as_slice()),
            (CHANNEL_PTY, b"input".as_slice()),
        ] {
            let sealed = browser
                .seal_stream(e2e::lane_for_channel(channel).unwrap(), payload)
                .unwrap();
            let mut msg = pty_message(peer_id, sealed, DeliveryMode::Stream);
            msg.channel_id = channel;
            msg.connection_id = 17;
            if channel == CHANNEL_PTY {
                msg.input_permit = Some(Arc::clone(&credit).acquire_owned().await.unwrap());
            }
            pointers.push(msg.payload.as_ptr());
            assert!(matches!(
                open_inbound_terminal(peers.get_mut(peer_id).unwrap(), &mut msg, &mut scratch),
                OpenOutcome::Drop
            ));
            assert!(
                msg.payload.is_empty(),
                "retention moves the ciphertext owner"
            );
        }
        assert_eq!(credit.available_permits(), 0);
        let (event_tx, _output) = crate::ipc::events::test_event_sink();
        let mut telemetry = session::rebind_flow::RebindTelemetry::new(event_tx);
        let frames = handle_noise_final(
            peer_id,
            &noise_final_envelope(&peers[peer_id], &msg3),
            &mut peers,
            &None,
            &Arc::new(RwLock::new(NetworkState::new())),
            &mut telemetry,
            20.0,
            None,
        )
        .await
        .unwrap();
        assert_eq!(frames.len(), 3);
        for ((mut msg, pointer), expected) in frames.into_iter().zip(pointers).zip([
            b"enable".as_slice(),
            b"probe".as_slice(),
            b"input".as_slice(),
        ]) {
            assert_eq!(msg.payload.as_ptr(), pointer);
            assert_eq!(msg.connection_id, 17);
            let OpenOutcome::Opened(len) =
                open_inbound_terminal(peers.get_mut(peer_id).unwrap(), &mut msg, &mut scratch)
            else {
                panic!("retained ciphertext opens only under the completed successor");
            };
            assert_eq!(&scratch[..len], expected);
            assert!(
                matches!(
                    open_inbound_terminal(peers.get_mut(peer_id).unwrap(), &mut msg, &mut scratch),
                    OpenOutcome::Drop
                ),
                "exactly-once dispatch"
            );
        }
        assert_eq!(credit.available_permits(), 1);
    }
}

#[tokio::test]
async fn failed_noise_final_discards_overtaking_ciphertext_and_releases_credit() {
    let peer_id = "failed-early-noise";
    let (peer, _, mut browser, mut msg3, _) = rebind_handshake_peer(peer_id);
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);
    let credit = Arc::new(tokio::sync::Semaphore::new(1));
    let sealed = browser
        .seal_stream(e2e::lane_for_channel(CHANNEL_PTY).unwrap(), b"input")
        .unwrap();
    let mut msg = pty_message(peer_id, sealed, DeliveryMode::Stream);
    msg.input_permit = Some(Arc::clone(&credit).acquire_owned().await.unwrap());
    assert!(matches!(
        open_inbound_terminal(peers.get_mut(peer_id).unwrap(), &mut msg, &mut Vec::new()),
        OpenOutcome::Drop
    ));
    assert_eq!(credit.available_permits(), 0);
    msg3[0] ^= 0x80;
    let (event_tx, _output) = crate::ipc::events::test_event_sink();
    let mut telemetry = session::rebind_flow::RebindTelemetry::new(event_tx);
    assert!(
        handle_noise_final(
            peer_id,
            &noise_final_envelope(&peers[peer_id], &msg3),
            &mut peers,
            &None,
            &Arc::new(RwLock::new(NetworkState::new())),
            &mut telemetry,
            20.0,
            None
        )
        .await
        .is_none()
    );
    assert_eq!(credit.available_permits(), 1);
    let peer = &peers[peer_id];
    assert!(peer.noise_handshake.is_none());
    assert!(peer.noise.is_some());
    assert!(peer.paths.webtransport.available);
    assert_eq!(peer.rebind.as_ref().unwrap().counter, 0);
}

#[test]
fn pending_noise_ingress_bounds_retire_the_attempt_without_touching_incumbent() {
    for bytes in [false, true] {
        let peer_id = "bounded-early-noise";
        let (mut peer, _, _, _, _) = rebind_handshake_peer(peer_id);
        let (capture, _output) = mpsc::unbounded_channel();
        let tunnel = Arc::new(edge_tunnel::EdgeTunnel::new_capture(capture));
        peer.edge_tunnel = Some(Arc::clone(&tunnel));
        let size = if bytes {
            network::peer::MAX_INBOUND_FRAME_BYTES
        } else {
            1
        };
        let count = if bytes { 2 } else { 128 };
        for _ in 0..count {
            let mut msg = pty_message(peer_id, vec![0; size], DeliveryMode::Stream);
            assert!(retain_pending_noise_frame(&mut peer, &mut msg));
            assert!(peer.noise_handshake.is_some());
        }
        let mut excess = pty_message(peer_id, vec![0], DeliveryMode::Stream);
        assert!(retain_pending_noise_frame(&mut peer, &mut excess));
        assert!(peer.noise_handshake.is_none());
        assert!(peer.noise.is_some());
        assert!(peer.paths.webtransport.available);
        assert!(
            tunnel
                .send_reliable(CHANNEL_CTRL, network::peer::ReliablePayload::Heap(vec![1]))
                .is_err()
        );
    }
}

fn prediction_latched_terminal() -> TerminalState {
    let (terminal_event_tx, _terminal_event_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_event_tx);
    terminal.apply_bytes(b"\x1b[?2004h");
    terminal.set_prediction_safe(true);
    assert!(terminal.shell_integration_input_active());
    terminal
}

#[test]
fn browser_sealed_pty_frame_decrypts_at_dispatch_boundary() {
    let peer_id = "browser-1";
    let (peer, mut browser) = authenticated_e2e_peer(peer_id);
    let mut peers: PeerMap = HashMap::new();
    peers.insert(peer_id.into(), peer);

    // Browser seals a sequenced-keystroke PTY frame on the PTY STREAM lane.
    let plaintext = encode_input_run(
        1,
        false,
        &[
            (&build::press('l')[..], true),
            (&build::press('s')[..], true),
            (&build::functional(0xE001, 0, 0)[..], false),
        ],
    );
    let lane = e2e::lane_for_channel(CHANNEL_PTY).unwrap();
    let sealed = browser.seal_stream(lane, &plaintext).unwrap();
    assert_ne!(sealed, plaintext, "frame is ciphertext on the wire");

    let mut msg = pty_message(peer_id, sealed, DeliveryMode::Stream);
    let mut scratch: Vec<u8> = Vec::new();
    match open_inbound_terminal(peers.get_mut(peer_id).unwrap(), &mut msg, &mut scratch) {
        OpenOutcome::Opened(decrypted_len) => {
            assert_eq!(
                &scratch[..decrypted_len],
                &plaintext[..],
                "dispatch boundary recovers PTY plaintext"
            );
        }
        _ => panic!("expected the sealed PTY frame to open at the dispatch boundary"),
    }
}

#[test]
fn unmodelled_input_revokes_but_authenticated_bit_preserves_prediction_latch() {
    let peer_id = "browser-provenance";

    let mut unmodelled_peers = PeerMap::from([(
        peer_id.into(),
        PeerDisplayState::new(peer_id.into(), PeerTransport::Edge),
    )]);
    let (mut unmodelled_writer, _unmodelled_completion_rx) =
        PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let mut unmodelled_terminal = prediction_latched_terminal();
    let unmodelled_payload = encode_input_run(1, false, &[(&build::press('x')[..], false)]);
    handle_pty_channel(
        &pty_message(peer_id, unmodelled_payload.clone(), DeliveryMode::Stream),
        &unmodelled_payload,
        &mut unmodelled_writer,
        &mut unmodelled_terminal,
        &mut unmodelled_peers,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
    assert!(
        !unmodelled_terminal.prediction_safe(),
        "an unmodelled entry carries no model provenance and must revoke prediction"
    );
    assert!(
        unmodelled_terminal.shell_integration_input_active(),
        "but a printable cannot start a silent read, so the shell's editor \
         boundary stays open and the next PTY sample can re-grant"
    );

    let mut modelled_peers = PeerMap::from([(
        peer_id.into(),
        PeerDisplayState::new(peer_id.into(), PeerTransport::Edge),
    )]);
    let (mut modelled_writer, _modelled_completion_rx) =
        PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let mut modelled_terminal = prediction_latched_terminal();
    let modelled_payload = encode_input_run(1, false, &[(&build::press('x')[..], true)]);
    handle_pty_channel(
        &pty_message(peer_id, modelled_payload.clone(), DeliveryMode::Stream),
        &modelled_payload,
        &mut modelled_writer,
        &mut modelled_terminal,
        &mut modelled_peers,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
    assert!(
        modelled_terminal.shell_integration_input_active(),
        "the authenticated per-entry bit preserves the current editor boundary"
    );
}

/// Dispatches one run on a fresh prediction-latched terminal and reports
/// whether the shell's editor boundary survived it.
fn editor_boundary_survives(record: &[u8], shadow_modelled: bool) -> bool {
    let peer_id = "browser-eligibility";
    let mut peers = PeerMap::from([(
        peer_id.into(),
        PeerDisplayState::new(peer_id.into(), PeerTransport::Edge),
    )]);
    let (mut writer, _completion_rx) = PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let mut terminal = prediction_latched_terminal();
    let payload = encode_input_run(1, false, &[(record, shadow_modelled)]);
    handle_pty_channel(
        &pty_message(peer_id, payload.clone(), DeliveryMode::Stream),
        &payload,
        &mut writer,
        &mut terminal,
        &mut peers,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
    terminal.shell_integration_input_active()
}

#[test]
fn a_shadow_claim_the_model_cannot_make_is_treated_as_unmodelled() {
    const ENTER: u32 = 0xE001;
    // Enter is never modelled: a browser claiming it would suppress the
    // revocation Enter owes, so the claim is ignored and the boundary closes.
    assert!(!editor_boundary_survives(
        &build::functional(ENTER, 0, 0),
        true
    ));
    // Nor is Ctrl+D, or Escape, however the browser marks them.
    assert!(!editor_boundary_survives(
        &build::key(build::Key {
            key: u32::from('d'),
            mods: input_record::mods::CTRL,
            ..build::Key::default()
        }),
        true,
    ));
    assert!(!editor_boundary_survives(
        &build::functional(0xE000, 0, 0),
        true
    ));
    // A modelled printable keeps it, and so does an unmodelled one.
    assert!(editor_boundary_survives(&build::press('x'), true));
    assert!(editor_boundary_survives(&build::press('x'), false));
}

#[test]
fn a_record_that_encodes_to_nothing_never_touches_the_prediction_grant() {
    let peer_id = "browser-release";
    let mut peers = PeerMap::from([(
        peer_id.into(),
        PeerDisplayState::new(peer_id.into(), PeerTransport::Edge),
    )]);
    let (mut writer, _completion_rx) = PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let mut terminal = prediction_latched_terminal();
    // No Kitty flag asks for releases, so this release is written as nothing.
    let release = build::key(build::Key {
        event: 2,
        key: u32::from('x'),
        ..build::Key::default()
    });
    let payload = encode_input_run(1, false, &[(&release[..], false)]);
    handle_pty_channel(
        &pty_message(peer_id, payload.clone(), DeliveryMode::Stream),
        &payload,
        &mut writer,
        &mut terminal,
        &mut peers,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
    assert!(terminal.prediction_safe());
}

/// A PTY sink the test can read back.
struct SharedSink(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for SharedSink {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn focus_is_reported_for_the_terminal_not_for_each_browser() {
    let (mut peers, _, _, mut terminal) = plaintext_dispatch_peer("browser-a");
    peers.insert(
        "browser-b".into(),
        PeerDisplayState::new("browser-b".into(), PeerTransport::Edge),
    );
    let written = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (mut pty_writer, mut completion_rx) =
        PtyWriter::new(Box::new(SharedSink(Arc::clone(&written)))).unwrap();
    terminal.apply_bytes(b"\x1b[?1004h");

    let mut next_seq = [("browser-a", 1_u32), ("browser-b", 1_u32)];
    let mut focus =
        async |peer: &str, focused: bool, peers: &mut PeerMap, terminal: &mut TerminalState| {
            let slot = next_seq
                .iter_mut()
                .find(|(id, _)| *id == peer)
                .expect("known peer");
            let seq = slot.1;
            slot.1 += 1;
            let run = encode_input_run(seq, false, &[(&build::focus(focused)[..], false)]);
            dispatch_pty_frame(
                peer,
                &run,
                Some(seq),
                peers,
                &mut pty_writer,
                &mut completion_rx,
                terminal,
            )
            .await;
            std::mem::take(&mut *written.lock().unwrap())
        };

    assert_eq!(
        focus("browser-a", true, &mut peers, &mut terminal).await,
        b"\x1b[I"
    );
    assert_eq!(
        focus("browser-b", true, &mut peers, &mut terminal).await,
        b""
    );
    assert_eq!(
        focus("browser-a", false, &mut peers, &mut terminal).await,
        b""
    );
    assert_eq!(
        focus("browser-b", false, &mut peers, &mut terminal).await,
        b"\x1b[O"
    );
    assert_eq!(
        focus("browser-b", false, &mut peers, &mut terminal).await,
        b""
    );

    // A focused browser that leaves without a focus-out is reported gone.
    focus("browser-a", true, &mut peers, &mut terminal).await;
    assert_eq!(
        terminal.release_departed_focus(|peer| peers.contains_key(peer)),
        None
    );
    peers.remove("browser-a");
    assert_eq!(
        terminal.release_departed_focus(|peer| peers.contains_key(peer)),
        Some(&b"\x1b[O"[..])
    );
    assert_eq!(
        terminal.release_departed_focus(|peer| peers.contains_key(peer)),
        None
    );
}

#[tokio::test]
async fn keys_are_encoded_in_the_modes_the_application_set() {
    let peer_id = "browser-kitty";
    let (mut peers, _, _, mut terminal) = plaintext_dispatch_peer(peer_id);
    let written = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (mut pty_writer, mut completion_rx) =
        PtyWriter::new(Box::new(SharedSink(Arc::clone(&written)))).unwrap();

    // The application pushes Kitty's disambiguate flag.
    terminal.apply_bytes(b"\x1b[>1u");
    let ctrl_c = build::key(build::Key {
        key: u32::from('c'),
        mods: input_record::mods::CTRL,
        ..build::Key::default()
    });
    let ctrl_c_release = build::key(build::Key {
        event: 2,
        key: u32::from('c'),
        mods: input_record::mods::CTRL,
        ..build::Key::default()
    });
    let run = encode_input_run(
        1,
        false,
        &[
            (&ctrl_c[..], false),
            // Encodes to nothing, yet its sequence is confirmed in order.
            (&ctrl_c_release[..], false),
            (&build::press('a')[..], true),
            (&build::functional(0xE000, 0, 0)[..], false),
        ],
    );
    dispatch_pty_frame(
        peer_id,
        &run,
        Some(4),
        &mut peers,
        &mut pty_writer,
        &mut completion_rx,
        &mut terminal,
    )
    .await;
    assert_eq!(&*written.lock().unwrap(), b"\x1b[99;5ua\x1b[27u");

    // It pops the flag and enables application cursor keys.
    written.lock().unwrap().clear();
    terminal.apply_bytes(b"\x1b[<u\x1b[?1h");
    let run = encode_input_run(
        5,
        false,
        &[
            (&ctrl_c[..], false),
            (&build::functional(0xE008, 0, 0)[..], false),
        ],
    );
    dispatch_pty_frame(
        peer_id,
        &run,
        Some(6),
        &mut peers,
        &mut pty_writer,
        &mut completion_rx,
        &mut terminal,
    )
    .await;
    assert_eq!(&*written.lock().unwrap(), b"\x03\x1bOA");
}

#[tokio::test]
async fn input_ack_returns_over_the_edge_without_a_direct_transport() {
    let peer_id = "browser-1";
    let (mut peer, mut browser) = authenticated_e2e_peer(peer_id);
    let (edge_tx, mut edge_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
    peer.edge_tunnel = Some(Arc::new(edge_tunnel::EdgeTunnel::new_capture(edge_tx)));

    let mut peers = HashMap::new();
    peers.insert(peer_id.into(), peer);
    let (mut pty_writer, mut completion_rx) = PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let mut parked_peers = ParkedPeers::new();
    let (terminal_event_tx, _terminal_event_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_event_tx);
    let plaintext = encode_input_run(
        1,
        false,
        &[
            (&build::press('l')[..], false),
            (&build::press('s')[..], false),
            (&build::functional(0xE001, 0, 0)[..], false),
        ],
    );
    let msg = PeerMessage {
        input_permit: None,
        peer_node_id: Arc::from(peer_id),
        channel_id: CHANNEL_PTY,
        payload: bytes::Bytes::from(plaintext),
        via_transport: PeerTransport::Edge,
        delivery: DeliveryMode::Stream,
        connection_id: 0,
        edge_ingress: None,
    };

    let msg_payload = msg.payload.clone();
    assert!(
        !handle_pty_channel(
            &msg,
            &msg_payload,
            &mut pty_writer,
            &mut terminal,
            &mut peers,
            Instant::now(),
            &mut PerfTimingTracker::default(),
        )
        .ack_pending,
        "a run that advanced the FIFO is acknowledged by its completions, not on arrival"
    );

    let mut input_ack_pending = false;
    while peers[peer_id].keystroke_next_expected_seq != 4 {
        let completion = completion_rx.recv().await.expect("PTY write completes");
        input_ack_pending |= handle_pty_write_completions(
            completion,
            &mut completion_rx,
            &mut pty_writer,
            &mut terminal,
            &mut peers,
            &mut parked_peers,
            &mut input::InputRefill::default(),
            &mut PerfTimingTracker::default(),
        )
        .expect("PTY write succeeds")
        .input_ack_queued;
    }
    assert!(
        input_ack_pending,
        "a confirmed keystroke sets the turn's level"
    );

    // The flush is external to the handler: however many completion turns
    // the writer thread produced above, the slot holds one record.
    flush_input_acks(&mut peers, 1_000.0, &mut PerfTimingTracker::default());
    assert_eq!(
        peers[peer_id].pending_input_ack, None,
        "a flush is one take"
    );

    // One logical ACK, sent once per Noise sub-lane of the arriving
    // carrier: the datagram copy is the fast one, the stream copy the
    // guaranteed one. Each opens only on its own lane.
    let lane = e2e::lane_for_channel(CHANNEL_PTY).unwrap();
    let mut stream_acks = 0;
    let mut datagram_acks = 0;
    while let Ok((channel_id, sealed)) = edge_rx.try_recv() {
        assert_eq!(channel_id, CHANNEL_PTY);
        if let Ok(plaintext) = browser.open_stream(lane, &sealed) {
            stream_acks += 1;
            assert_eq!(plaintext, encode_input_ack(3).to_vec());
        } else {
            let plaintext = browser
                .open_datagram(lane, &sealed)
                .expect("a record that is not a stream ACK is the datagram twin");
            datagram_acks += 1;
            assert_eq!(plaintext, encode_input_ack(3).to_vec());
        }
    }
    assert_eq!(
        stream_acks, 1,
        "cumulative input ACKs are coalesced on the stream"
    );
    assert_eq!(datagram_acks, 1, "and carried once on the datagram lane");
    assert_eq!(peers[peer_id].latest_input_seq, 3);
}

#[test]
fn terminal_frame_before_e2e_is_dropped() {
    let peer_id = "browser-2";
    let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
    peer.authenticated = true; // authenticated, but NO noise transport yet
    let mut peers: PeerMap = HashMap::new();
    peers.insert(peer_id.into(), peer);

    let mut msg = pty_message(
        peer_id,
        b"plaintext-keystroke".to_vec(),
        DeliveryMode::Stream,
    );
    assert!(
        matches!(
            open_inbound_terminal(peers.get_mut(peer_id).unwrap(), &mut msg, &mut Vec::new()),
            OpenOutcome::Drop
        ),
        "no terminal frame is accepted before E2E is established"
    );
}

#[tokio::test]
async fn convergence_probe_requires_current_profiler_and_returns_fresh_authoritative_hashes() {
    let peer_id = "browser-convergence";
    let (mut peer, mut browser) = authenticated_e2e_peer(peer_id);
    peer.display_cache.resize(8, 3);
    peer.last_display_seq_sent = 41;
    let generation = peer.generation;
    let signal_session_id = peer.signal_session_id.clone();
    let (edge_tx, mut edge_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
    peer.edge_tunnel = Some(Arc::new(edge_tunnel::EdgeTunnel::new_capture(edge_tx)));
    let mut peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);
    let (terminal_event_tx, _terminal_event_rx) = unbounded();
    let mut terminal = TerminalState::new(8, 3, terminal_event_tx);
    terminal.apply_bytes(b"first\r\nsecond");
    let mut expected_hashes = Vec::new();
    terminal.current_row_hashes_into(&mut expected_hashes);
    let mut tracker = PerfTimingTracker::default();
    tracker.configure(Arc::from(peer_id), &signal_session_id, true, 7);
    let msg = PeerMessage {
        input_permit: None,
        peer_node_id: Arc::from(peer_id),
        channel_id: CHANNEL_CTRL,
        payload: bytes::Bytes::new(),
        via_transport: PeerTransport::Edge,
        delivery: DeliveryMode::Stream,
        connection_id: 0,
        edge_ingress: None,
    };

    let datagram_msg = PeerMessage {
        input_permit: None,
        peer_node_id: Arc::from(peer_id),
        channel_id: CHANNEL_CTRL,
        payload: bytes::Bytes::new(),
        via_transport: PeerTransport::Edge,
        delivery: DeliveryMode::Datagram,
        connection_id: 0,
        edge_ingress: None,
    };
    handle_perf_grid_convergence_request(
        &datagram_msg,
        &[0, 0, 0, 7, 0, 0, 0, 9],
        &mut terminal,
        &mut peers,
        &tracker,
        99.0,
    );
    assert!(
        edge_rx.try_recv().is_err(),
        "a convergence request on the datagram sub-lane must be dropped",
    );

    handle_perf_grid_convergence_request(
        &msg,
        &[0, 0, 0, 8, 0, 0, 0, 1],
        &mut terminal,
        &mut peers,
        &tracker,
        100.0,
    );
    assert!(
        edge_rx.try_recv().is_err(),
        "a stale observation epoch cannot trigger a grid traversal response",
    );

    peers.get_mut(peer_id).expect("peer").signal_session_id = "replacement-session".to_owned();
    handle_perf_grid_convergence_request(
        &msg,
        &[0, 0, 0, 7, 0, 0, 0, 9],
        &mut terminal,
        &mut peers,
        &tracker,
        100.5,
    );
    assert!(
        edge_rx.try_recv().is_err(),
        "an observation owner from a replaced signaling session must be fenced",
    );
    peers.get_mut(peer_id).expect("peer").signal_session_id = signal_session_id.clone();

    handle_perf_grid_convergence_request(
        &msg,
        &[0, 0, 0, 7, 0, 0, 0, 9],
        &mut terminal,
        &mut peers,
        &tracker,
        101.0,
    );
    let (channel, ciphertext) = edge_rx.try_recv().expect("convergence response");
    assert_eq!(channel, CHANNEL_CTRL);
    let lane = e2e::lane_for_channel(CHANNEL_CTRL).expect("CTRL lane");
    let plaintext = browser
        .open_stream(lane, &ciphertext)
        .expect("authenticated response opens");
    let (msg_type, body) = decode_proto_frame(&plaintext).expect("protocol response");
    assert_eq!(msg_type, MSG_TYPE_PERF_GRID_CONVERGENCE_RESPONSE);
    assert_eq!(&body[0..4], &7u32.to_be_bytes());
    assert_eq!(&body[4..8], &9u32.to_be_bytes());
    assert_eq!(&body[8..12], &generation.to_be_bytes());
    assert_eq!(&body[12..16], &41u32.to_be_bytes());
    assert_eq!(&body[16..18], &8u16.to_be_bytes());
    assert_eq!(&body[18..20], &3u16.to_be_bytes());
    let observed_hashes = body[20..]
        .chunks_exact(8)
        .map(|bytes| u64::from_be_bytes(bytes.try_into().expect("hash width")))
        .collect::<Vec<_>>();
    assert_eq!(observed_hashes, expected_hashes);
    assert!(edge_rx.try_recv().is_err());
}

#[test]
fn wrong_delivery_mode_fails_open_and_drops() {
    let peer_id = "browser-3";
    let (peer, mut browser) = authenticated_e2e_peer(peer_id);
    let mut peers: PeerMap = HashMap::new();
    peers.insert(peer_id.into(), peer);

    // Sealed on the STREAM lane but delivered as a Datagram: the open picks
    // the datagram sub-lane and fails authentication — the frame is dropped,
    // never dispatched as plaintext.
    let lane = e2e::lane_for_channel(CHANNEL_PTY).unwrap();
    let sealed = browser
        .seal_stream(
            lane,
            &encode_input_run(1, false, &[(&build::press('x')[..], false)]),
        )
        .unwrap();
    let mut msg = pty_message(peer_id, sealed, DeliveryMode::Datagram);
    assert!(matches!(
        open_inbound_terminal(peers.get_mut(peer_id).unwrap(), &mut msg, &mut Vec::new()),
        OpenOutcome::Drop
    ));
}

/// A plaintext-dispatch peer: authenticated state is not needed because
/// `handle_pty_channel` runs after the E2E open, on the decrypted bytes.
fn plaintext_dispatch_peer(
    peer_id: &str,
) -> (
    PeerMap,
    PtyWriter,
    mpsc::UnboundedReceiver<PtyWriteCompletion>,
    TerminalState,
) {
    let mut peers = PeerMap::new();
    peers.insert(
        peer_id.into(),
        PeerDisplayState::new(peer_id.into(), PeerTransport::Edge),
    );
    let (pty_writer, completion_rx) = PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let (terminal_event_tx, _terminal_event_rx) = unbounded();
    let terminal = TerminalState::new(80, 24, terminal_event_tx);
    (peers, pty_writer, completion_rx, terminal)
}

/// Dispatches one PTY-lane frame and, when `confirm_through` is set, drains
/// PTY write completions until the peer has confirmed that seq. Returns
/// the turn's level: whether anything queued an input ack.
async fn dispatch_pty_frame(
    peer_id: &str,
    frame: &[u8],
    confirm_through: Option<u32>,
    peers: &mut PeerMap,
    pty_writer: &mut PtyWriter,
    completion_rx: &mut mpsc::UnboundedReceiver<PtyWriteCompletion>,
    terminal: &mut TerminalState,
) -> bool {
    let msg = pty_message(peer_id, frame.to_vec(), DeliveryMode::Stream);
    let mut input_ack_pending = handle_pty_channel(
        &msg,
        frame,
        pty_writer,
        terminal,
        peers,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    )
    .ack_pending;
    let Some(confirm_through) = confirm_through else {
        return input_ack_pending;
    };
    let mut parked_peers = ParkedPeers::new();
    while peers[peer_id].keystroke_next_expected_seq != confirm_through.wrapping_add(1) {
        let completion = completion_rx.recv().await.expect("PTY write completes");
        input_ack_pending |= handle_pty_write_completions(
            completion,
            completion_rx,
            pty_writer,
            terminal,
            peers,
            &mut parked_peers,
            &mut input::InputRefill::default(),
            &mut PerfTimingTracker::default(),
        )
        .expect("PTY write succeeds")
        .input_ack_queued;
    }
    input_ack_pending
}

fn queued_ack(peers: &PeerMap, peer_id: &str) -> Option<u32> {
    peers[peer_id]
        .pending_input_ack
        .map(|pending| pending.ack_seq)
}

#[tokio::test]
async fn a_retransmitted_non_advancing_run_is_acknowledged() {
    let peer_id = "browser-retry";
    let (mut peers, mut pty_writer, mut completion_rx, mut terminal) =
        plaintext_dispatch_peer(peer_id);
    let first = encode_input_run(
        1,
        false,
        &[
            (&build::press('l')[..], false),
            (&build::press('s')[..], false),
        ],
    );
    assert!(
        dispatch_pty_frame(
            peer_id,
            &first,
            Some(2),
            &mut peers,
            &mut pty_writer,
            &mut completion_rx,
            &mut terminal,
        )
        .await
    );
    // The turn that confirmed the input flushed its ack; the slot is clear.
    peers.get_mut(peer_id).unwrap().pending_input_ack = None;

    // The idle retry re-emits the same suffix with the mark set: the
    // browser has heard nothing, so the daemon must answer even though the
    // run advanced nothing.
    let retried = encode_input_run(
        1,
        true,
        &[
            (&build::press('l')[..], false),
            (&build::press('s')[..], false),
        ],
    );
    assert!(
        dispatch_pty_frame(
            peer_id,
            &retried,
            None,
            &mut peers,
            &mut pty_writer,
            &mut completion_rx,
            &mut terminal,
        )
        .await,
        "a marked retransmission sets the turn's level"
    );
    assert_eq!(
        peers[peer_id].pending_input_ack,
        Some(PendingInputAck {
            ack_seq: 2,
            via_transport: PeerTransport::Edge,
        })
    );
}

#[tokio::test]
async fn a_duplicate_run_without_the_retransmit_mark_is_not_acknowledged() {
    let peer_id = "browser-dup-run";
    let (mut peers, mut pty_writer, mut completion_rx, mut terminal) =
        plaintext_dispatch_peer(peer_id);
    let run = encode_input_run(
        1,
        false,
        &[
            (&build::press('l')[..], false),
            (&build::press('s')[..], false),
        ],
    );
    dispatch_pty_frame(
        peer_id,
        &run,
        Some(2),
        &mut peers,
        &mut pty_writer,
        &mut completion_rx,
        &mut terminal,
    )
    .await;
    peers.get_mut(peer_id).unwrap().pending_input_ack = None;

    // The same run again, as the dual-send twin or a reorder-gap insert
    // delivers it: nothing advances, and nothing asked for an ack.
    assert!(
        !dispatch_pty_frame(
            peer_id,
            &run,
            None,
            &mut peers,
            &mut pty_writer,
            &mut completion_rx,
            &mut terminal,
        )
        .await,
        "an unmarked duplicate must not set the turn's level"
    );
    assert_eq!(
        queued_ack(&peers, peer_id),
        None,
        "a duplicate run that is not a retransmission must not queue an ack"
    );
}

#[tokio::test]
async fn a_duplicate_sequenced_keystroke_is_never_acknowledged() {
    let peer_id = "browser-dup-keystroke";
    let (mut peers, mut pty_writer, mut completion_rx, mut terminal) =
        plaintext_dispatch_peer(peer_id);
    let mut body = 1_u32.to_be_bytes().to_vec();
    body.extend_from_slice(&build::press('x'));
    let keystroke = encode_proto_frame(MSG_TYPE_SEQUENCED_KEYSTROKE, &body);
    dispatch_pty_frame(
        peer_id,
        &keystroke,
        Some(1),
        &mut peers,
        &mut pty_writer,
        &mut completion_rx,
        &mut terminal,
    )
    .await;
    peers.get_mut(peer_id).unwrap().pending_input_ack = None;

    // A sequenced keystroke rides only the reliable stream and is never
    // re-emitted, so a duplicate is a replay that is owed nothing.
    assert!(
        !dispatch_pty_frame(
            peer_id,
            &keystroke,
            None,
            &mut peers,
            &mut pty_writer,
            &mut completion_rx,
            &mut terminal,
        )
        .await
    );
    assert_eq!(
        queued_ack(&peers, peer_id),
        None,
        "a sequenced keystroke rides only the stream and is never re-emitted, so its duplicate never earns an ack"
    );
}

/// The `(channel, sealed record)` pairs an edge capture tunnel receives.
type CapturedEdgeRecords = mpsc::UnboundedReceiver<(u8, Vec<u8>)>;

/// An authenticated peer whose edge carrier is a capture channel, so the
/// acks it is sent can be counted and opened by the browser half.
fn captured_edge_peer(peer_id: &str) -> (PeerMap, e2e::NoiseTransport, CapturedEdgeRecords) {
    let (mut peer, browser) = authenticated_e2e_peer(peer_id);
    let (edge_tx, edge_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
    peer.edge_tunnel = Some(Arc::new(edge_tunnel::EdgeTunnel::new_capture(edge_tx)));
    let mut peers = HashMap::new();
    peers.insert(peer_id.into(), peer);
    (peers, browser, edge_rx)
}

/// An edge input ACK holds its connection's packet construction until the
/// turn releases it, so the frame the display flush admits next leaves with
/// it: while the hold is live nothing reaches the edge, and after the
/// release both datagrams do. (That held admissions share one transmit is
/// quinn-patch's `driver_io` proof.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edge_input_ack_waits_for_the_frame_the_flush_admits_next() {
    let (tunnel, edge, _edge_guard) = edge_tunnel::connected_interactive_test_tunnel().await;
    let peer_id = "held-ack-peer";
    let (mut peer, _browser) = authenticated_e2e_peer(peer_id);
    peer.edge_tunnel = Some(Arc::clone(&tunnel));
    peer.pending_input_ack = Some(PendingInputAck {
        ack_seq: 7,
        via_transport: PeerTransport::Edge,
    });
    let mut peers: PeerMap = HashMap::new();
    peers.insert(peer_id.into(), peer);
    let edge_quic = edge.quic_connection();
    tokio::time::timeout(Duration::from_secs(10), async {
        while edge_quic.stats().path.bytes_in_flight != 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the tunnel settles");
    // Delayed acknowledgments leave within their maximum ACK delay.
    tokio::time::sleep(Duration::from_millis(60)).await;
    let received_before = edge_quic.stats().frame_rx.datagram;

    flush_input_acks(&mut peers, 1_000.0, &mut PerfTimingTracker::default());
    assert!(
        peers[peer_id].egress_hold.is_some(),
        "the edge ACK took no hold"
    );
    let frame = bytes::Bytes::from_static(&[CHANNEL_DISPLAY_DATAGRAM, 1, 2, 3]);
    assert!(tunnel.send_framed_datagram(&frame));
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        edge_quic.stats().frame_rx.datagram,
        received_before,
        "a datagram left while the ACK's hold was live"
    );

    display::send::release_egress_holds(&mut peers);
    assert!(peers[peer_id].egress_hold.is_none());
    let mut channels = Vec::new();
    let mut batch = wtransport::datagram::DatagramBatch::default();
    while channels.len() < 2 {
        tokio::time::timeout(Duration::from_secs(5), edge.receive_datagrams(&mut batch))
            .await
            .expect("the release lets the held datagrams leave")
            .unwrap();
        channels.extend(batch.payloads().iter().map(|payload| payload[0]));
    }
    assert_eq!(channels, [CHANNEL_PTY, CHANNEL_DISPLAY_DATAGRAM]);
}

/// A direct input ACK holds its session's packet construction the same
/// way, and the frame the flush admits next leaves in the ACK's packet: the
/// browser receives both in one UDP datagram. The negative control releases
/// the hold and lets the ACK arrive before the frame is admitted, and the
/// same count reads two.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_direct_input_ack_leaves_in_one_packet_with_the_frame_the_flush_admits_next() {
    for held in [true, false] {
        let pair = webtransport::loopback_pair().await;
        let (senders, mut lanes) = webtransport::captured_lanes();
        let peer_id = "held-direct-ack-peer";
        let (mut peer, _browser) = authenticated_e2e_peer(peer_id);
        peer.direct_session = Some(webtransport::DirectSession::new(
            Arc::clone(&pair.daemon),
            senders,
        ));
        peer.paths.webtransport = connection::PathHealth::fresh_available(0.0);
        peer.pending_input_ack = Some(PendingInputAck {
            ack_seq: 7,
            via_transport: PeerTransport::WebTransport,
        });
        let mut peers: PeerMap = HashMap::new();
        peers.insert(peer_id.into(), peer);
        // Both halves idle, so the count below sees only what this turn sends
        // (keep-alive is seconds away on a fresh session).
        let (daemon_quic, browser_quic) = (
            pair.daemon.quic_connection(),
            pair.browser.quic_connection(),
        );
        tokio::time::timeout(Duration::from_secs(10), async {
            while daemon_quic.stats().path.bytes_in_flight != 0
                || browser_quic.stats().path.bytes_in_flight != 0
            {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("the session settles");
        // Delayed acknowledgments leave within their maximum ACK delay.
        tokio::time::sleep(Duration::from_millis(60)).await;
        let received_before = browser_quic.stats().udp_rx.datagrams;

        flush_input_acks(&mut peers, 1_000.0, &mut PerfTimingTracker::default());
        assert!(
            peers[peer_id].egress_hold.is_some(),
            "the direct ACK took no hold"
        );
        assert!(
            lanes.pty.try_recv().is_ok(),
            "the reliable twin was admitted on the direct session"
        );
        let mut channels = Vec::new();
        if !held {
            display::send::release_egress_holds(&mut peers);
            let ack = tokio::time::timeout(Duration::from_secs(5), pair.browser.receive_datagram())
                .await
                .expect("the released ACK arrives")
                .unwrap();
            channels.push(ack.payload()[0]);
        }
        let frame = bytes::Bytes::from_static(&[CHANNEL_DISPLAY_DATAGRAM, 1, 2, 3]);
        assert!(
            peers[peer_id]
                .direct_session
                .as_ref()
                .is_some_and(|session| session.send_datagram_owned(&frame))
        );
        display::send::release_egress_holds(&mut peers);
        assert!(peers[peer_id].egress_hold.is_none());
        let mut batch = wtransport::datagram::DatagramBatch::default();
        while channels.len() < 2 {
            tokio::time::timeout(
                Duration::from_secs(5),
                pair.browser.receive_datagrams(&mut batch),
            )
            .await
            .expect("the datagrams arrive")
            .unwrap();
            channels.extend(batch.payloads().iter().map(|payload| payload[0]));
        }
        assert_eq!(channels, [CHANNEL_PTY, CHANNEL_DISPLAY_DATAGRAM]);
        assert_eq!(
            browser_quic.stats().udp_rx.datagrams - received_before,
            if held { 1 } else { 2 },
            "held: {held}"
        );
    }
}

/// The reliable-lane ACK records, in order. Every one of them is sent
/// with a datagram twin on the same carrier; the twins are opened and
/// matched here so a flush that produced one without the other fails.
fn drain_acks(
    edge_rx: &mut CapturedEdgeRecords,
    browser: &mut e2e::NoiseTransport,
) -> Vec<Vec<u8>> {
    let lane = e2e::lane_for_channel(CHANNEL_PTY).unwrap();
    let mut stream_acks = Vec::new();
    let mut datagram_acks = Vec::new();
    while let Ok((channel_id, sealed)) = edge_rx.try_recv() {
        assert_eq!(channel_id, CHANNEL_PTY);
        match browser.open_stream(lane, &sealed) {
            Ok(plaintext) => stream_acks.push(plaintext),
            Err(_) => datagram_acks.push(
                browser
                    .open_datagram(lane, &sealed)
                    .expect("a record that is not a stream ACK is its datagram twin"),
            ),
        }
    }
    assert_eq!(
        datagram_acks, stream_acks,
        "every reliable ACK has exactly one datagram twin carrying the same seq"
    );
    stream_acks
}

/// Exact allocation oracle for the ack's send path up to carrier
/// admission: frame on the stack, sealed into a stack array, wrapped
/// inline. Bracketed by the process-wide counting allocator, so it runs
/// alone (`--exact`). The superseded arm — the shape the daemon shipped
/// before this work: a `Vec` frame sealed into a fresh `Vec` — is measured
/// in the same process so the delta is observed rather than asserted.
#[test]
#[ignore = "exact allocation oracle; the counting allocator is process-wide"]
fn sealing_an_input_ack_allocates_nothing() {
    use edge_tunnel::test_allocations;
    const SAMPLES: usize = 256;
    let peer_id = "browser-alloc";
    // The round trip through the browser half is proven by
    // `input_ack_returns_over_the_edge_without_a_direct_transport`; this
    // oracle measures only the daemon's side of it.
    let (mut peer, _browser) = authenticated_e2e_peer(peer_id);

    // Production: frame and ciphertext on the stack, then the inline
    // record. Warmed once so any first-touch cost is not attributed.
    let seal_inline = |peer: &mut PeerDisplayState, seq: u32| -> ReliablePayload {
        let frame = encode_input_ack(seq);
        let mut sealed = [0u8; INLINE_RELIABLE_PAYLOAD_BYTES];
        let sealed_len = peer
            .seal_stream_into(CHANNEL_PTY, &frame, &mut sealed)
            .expect("established transport");
        ReliablePayload::inline(sealed_len, sealed)
    };
    std::hint::black_box(seal_inline(&mut peer, 0));
    test_allocations::begin();
    let mut records = [0usize; SAMPLES];
    for (seq, slot) in records.iter_mut().enumerate() {
        let record = seal_inline(&mut peer, seq as u32 + 1);
        *slot = std::hint::black_box(&record).as_slice().len();
    }
    let production = test_allocations::end();
    assert!(
        records
            .iter()
            .all(|len| *len == INLINE_RELIABLE_PAYLOAD_BYTES)
    );
    assert_eq!(
        production,
        test_allocations::Tally {
            allocations: 0,
            allocated_bytes: 0,
        },
        "encoding, sealing and wrapping an input ack must not touch the heap"
    );

    // Superseded: `encode_proto_frame` allocated the 8-byte frame and
    // `seal_stream` allocated the 32-byte ciphertext — 2 allocations,
    // 40 bytes per ack, the baseline recorded for HEAD 2e88c40.
    test_allocations::begin();
    let superseded_record = peer
        .seal_stream(
            CHANNEL_PTY,
            &encode_proto_frame(MSG_TYPE_INPUT_ACK, &(SAMPLES as u32 + 2).to_be_bytes()),
        )
        .expect("established transport");
    let superseded = test_allocations::end();
    assert_eq!(
        superseded,
        test_allocations::Tally {
            allocations: 2,
            allocated_bytes: INPUT_ACK_FRAME_BYTES + INLINE_RELIABLE_PAYLOAD_BYTES,
        },
        "the superseded arm allocated the frame and the ciphertext"
    );
    assert_eq!(
        superseded_record.len(),
        INLINE_RELIABLE_PAYLOAD_BYTES,
        "both arms produce the same-sized ciphertext"
    );
}

/// The datagram twin of an input ack, a pong and a heartbeat are sealed into
/// one pooled wire owner. Once the previous owner has left its carrier,
/// sealing the next allocates nothing, and the browser opens exactly the frame
/// behind the channel byte.
#[test]
fn sealing_a_control_datagram_reuses_its_wire_owner() {
    use edge_tunnel::test_allocations;
    let (mut peer, mut browser) = authenticated_e2e_peer("browser-control-wire");
    let lane = e2e::lane_for_channel(CHANNEL_PTY).unwrap();
    drop(
        peer.seal_control_wire(CHANNEL_PTY, &encode_input_ack(1))
            .expect("established transport"),
    );
    for seq in 2..66 {
        let frame = encode_input_ack(seq);
        test_allocations::begin_thread();
        let wire = peer
            .seal_control_wire(CHANNEL_PTY, &frame)
            .expect("established transport");
        let tally = test_allocations::end_thread();
        assert_eq!(tally.allocations, 0, "ack {seq} allocated its wire");
        assert_eq!(wire[0], CHANNEL_PTY);
        assert_eq!(browser.open_datagram(lane, &wire[1..]).unwrap(), frame);
    }
}

/// A record that wrote nothing is covered by the record behind it in the
/// FIFO: its completion alone queues no ack and advances no advertisement,
/// so a release riding with the next key costs neither an ack pair nor a
/// header-only display frame of its own.
#[tokio::test]
async fn an_empty_record_ahead_of_a_queued_key_is_answered_by_that_key() {
    let peer_id = "browser-empty-ahead";
    let (mut peers, _browser, _edge_rx) = captured_edge_peer(peer_id);
    let (mut pty_writer, mut writer_completion_rx) =
        PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let (terminal_event_tx, _terminal_event_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_event_tx);
    let mut parked_peers = ParkedPeers::new();

    // A left-Shift release encodes to nothing without Kitty flags.
    let run = encode_input_run(
        1,
        false,
        &[
            (&build::functional(0xE061, 2, 0)[..], false),
            (&build::press('b')[..], false),
        ],
    );
    let msg = pty_message(peer_id, run.clone(), DeliveryMode::Stream);
    handle_pty_channel(
        &msg,
        &run,
        &mut pty_writer,
        &mut terminal,
        &mut peers,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
    let (_idle_tx, mut idle_rx) = mpsc::unbounded_channel();
    let mut drain_one = |completion, peers: &mut PeerMap| {
        handle_pty_write_completions(
            completion,
            &mut idle_rx,
            &mut pty_writer,
            &mut terminal,
            peers,
            &mut parked_peers,
            &mut input::InputRefill::default(),
            &mut PerfTimingTracker::default(),
        )
        .expect("PTY writes succeed")
    };

    let empty = writer_completion_rx.recv().await.expect("empty completion");
    let turn = drain_one(empty, &mut peers);
    assert!(!turn.input_ack_queued);
    assert_eq!(peers[peer_id].pending_input_ack, None);
    assert_eq!(peers[peer_id].latest_input_seq, 0);

    let key = writer_completion_rx.recv().await.expect("key completion");
    let turn = drain_one(key, &mut peers);
    assert!(turn.input_ack_queued);
    assert_eq!(
        peers[peer_id].pending_input_ack,
        Some(PendingInputAck {
            ack_seq: 2,
            via_transport: PeerTransport::Edge,
        }),
    );
    assert_eq!(peers[peer_id].latest_input_seq, 2);
}

/// Coalescing within a turn is the newest-wins slot: three completions
/// handled by one drain produce one record covering all of them.
#[tokio::test]
async fn completions_in_one_turn_coalesce_to_one_ack() {
    let peer_id = "browser-one-turn";
    let (mut peers, mut browser, mut edge_rx) = captured_edge_peer(peer_id);
    let (mut pty_writer, mut writer_completion_rx) =
        PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let (terminal_event_tx, _terminal_event_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_event_tx);
    let mut parked_peers = ParkedPeers::new();

    let run = encode_input_run(
        1,
        false,
        &[
            (&build::press('a')[..], false),
            (&build::press('b')[..], false),
            (&build::press('c')[..], false),
        ],
    );
    let msg = pty_message(peer_id, run.clone(), DeliveryMode::Stream);
    handle_pty_channel(
        &msg,
        &run,
        &mut pty_writer,
        &mut terminal,
        &mut peers,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
    // Gather the writer thread's three completions first, then hand them
    // to ONE drain so the turn boundary is exact rather than a race.
    let (turn_tx, mut turn_rx) = mpsc::unbounded_channel();
    let first = writer_completion_rx.recv().await.expect("first completion");
    for _ in 0..2 {
        turn_tx
            .send(writer_completion_rx.recv().await.expect("completion"))
            .unwrap();
    }
    let turn = handle_pty_write_completions(
        first,
        &mut turn_rx,
        &mut pty_writer,
        &mut terminal,
        &mut peers,
        &mut parked_peers,
        &mut input::InputRefill::default(),
        &mut PerfTimingTracker::default(),
    )
    .expect("PTY writes succeed");
    assert_eq!(
        turn,
        PtyCompletionTurn {
            handled: 3,
            input_ack_queued: true,
        }
    );
    assert_eq!(
        peers[peer_id].pending_input_ack,
        Some(PendingInputAck {
            ack_seq: 3,
            via_transport: PeerTransport::Edge,
        }),
        "three confirmations in one turn leave one record, the newest"
    );

    flush_input_acks(&mut peers, 1_000.0, &mut PerfTimingTracker::default());
    assert_eq!(
        drain_acks(&mut edge_rx, &mut browser),
        vec![encode_input_ack(3).to_vec()],
        "one turn, one ack, covering every seq the turn confirmed"
    );
    assert_eq!(peers[peer_id].pending_input_ack, None);
}

/// Coalescing across turns is deleted: each owner turn that confirms
/// input sends that turn's ack on that turn, never deferred to a clock.
#[tokio::test]
async fn completions_across_turns_ack_each_turn() {
    let peer_id = "browser-turns";
    let (mut peers, mut browser, mut edge_rx) = captured_edge_peer(peer_id);
    let (mut pty_writer, mut completion_rx) = PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let (terminal_event_tx, _terminal_event_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_event_tx);

    let mut acked = Vec::new();
    for seq in 1..=2u32 {
        let run = encode_input_run(seq, false, &[(&build::press('a')[..], false)]);
        let input_ack_pending = dispatch_pty_frame(
            peer_id,
            &run,
            Some(seq),
            &mut peers,
            &mut pty_writer,
            &mut completion_rx,
            &mut terminal,
        )
        .await;
        assert!(input_ack_pending, "turn {seq} confirmed input");
        // The owner turn ends here: whatever this turn queued is flushed.
        flush_input_acks(&mut peers, 1_000.0, &mut PerfTimingTracker::default());
        acked.extend(drain_acks(&mut edge_rx, &mut browser));
    }
    assert_eq!(
        acked,
        vec![encode_input_ack(1).to_vec(), encode_input_ack(2).to_vec()],
        "each owner turn that confirmed input sends that turn's ack on that turn"
    );
}
