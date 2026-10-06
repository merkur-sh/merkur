use super::*;

const PEER_ID: &str = "browser-bulk";

async fn harness() -> (
    Arc<RwLock<NetworkState>>,
    PeerMap,
    tokio::sync::mpsc::UnboundedReceiver<(u8, Vec<u8>)>,
) {
    let (capture_tx, capture_rx) = mpsc::unbounded_channel();
    let tunnel = Arc::new(edge_tunnel::EdgeTunnel::new_capture(capture_tx));
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    network_state
        .write()
        .await
        .edge_bulk
        .insert(PEER_ID.to_string(), tunnel);
    let psk = [7; 32];
    let mut browser =
        e2e::NoiseHandshake::new_initiator(&[1; 32], &psk, b"data-attach-test").unwrap();
    let mut daemon =
        e2e::NoiseHandshake::new_responder(&[2; 32], &psk, b"data-attach-test").unwrap();
    daemon
        .read_message(&browser.write_message(b"").unwrap())
        .unwrap();
    browser
        .read_message(&daemon.write_message(b"").unwrap())
        .unwrap();
    daemon
        .read_message(&browser.write_message(b"").unwrap())
        .unwrap();
    let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(daemon.into_transport().unwrap());
    let peers = PeerMap::from([(PEER_ID.into(), peer)]);
    (network_state, peers, capture_rx)
}

fn current_wt_state(peer_id: &str, connection_id: u64) -> Arc<RwLock<WebTransportState>> {
    let mut state = WebTransportState::new(
        webtransport::CertState {
            cert_hash: [0; 32],
            created_at: Instant::now(),
            valid_for: Duration::from_secs(60),
        },
        443,
        Vec::new(),
        webtransport::pairing::NatSignature {
            public_ip: None,
            nat_type: webtransport::pairing::NatTypeLabel::None,
            hairpin: false,
        },
        webtransport::stun::NatMapping::Unknown,
        None,
    );
    let (ctrl, _) = mpsc::channel(1);
    let (pty, _) = mpsc::channel(1);
    let (display_commit, _) = mpsc::channel(1);
    state.peer_connections.insert(
        peer_id.to_string(),
        network::peer::ChannelPeerConnection {
            senders: network::peer::ChannelSenders {
                ctrl,
                pty,
                display_commit,
                signaling: None,
            },
            connection_id,
        },
    );
    Arc::new(RwLock::new(state))
}

fn current_hello(nonce: &[u8; DATA_HANDSHAKE_NONCE_BYTES]) -> Vec<u8> {
    encode_data_handshake_frame(DataHandshakeKind::Hello, nonce)
}

#[test]
fn data_attachment_nonce_requires_exact_binary_and_json_shapes() {
    assert_eq!(parse_data_hello_generation(&[]), None);
    assert_eq!(decode_data_attachment_nonce(""), None);
    assert_eq!(
        decode_data_attachment_nonce(&"é".repeat(DATA_HANDSHAKE_NONCE_BYTES)),
        None
    );
    let nonce = [0x31; DATA_HANDSHAKE_NONCE_BYTES];
    assert_eq!(
        parse_data_hello_generation(&current_hello(&nonce)),
        Some(nonce)
    );
    assert_eq!(
        parse_data_hello_generation(&encode_data_generation_frame(DataHandshakeKind::Ack, nonce)),
        None
    );
}

#[tokio::test]
async fn data_rendezvous_handles_both_arrival_orders_without_an_extra_flight() {
    for lane in [EdgeLane::Interactive, EdgeLane::Bulk] {
        for hello_first in [true, false] {
            let (network, mut peers, mut rx) = harness().await;
            peers.get_mut(PEER_ID).unwrap().data_rendezvous_pending = true;
            let tunnel = network.read().await.edge_bulk[PEER_ID].clone();
            if lane == EdgeLane::Interactive {
                network
                    .write()
                    .await
                    .edge_interactive
                    .insert(PEER_ID.into(), tunnel.clone());
            }
            let nonce = [0x42; DATA_HANDSHAKE_NONCE_BYTES];
            let index = usize::from(lane == EdgeLane::Bulk);
            if hello_first {
                tunnel.observe_browser_hello(nonce);
            } else {
                peers.get_mut(PEER_ID).unwrap().data_attachment_nonces[index] = Some(nonce);
            }
            assert!(!link_data_tunnel(&network, &mut peers, PEER_ID, lane, 10.0).await);
            assert!(peers[PEER_ID].data_rendezvous_pending);
            assert!(rx.try_recv().is_err());
            tunnel.observe_browser_hello(nonce);
            peers.get_mut(PEER_ID).unwrap().data_attachment_nonces[index] = Some(nonce);
            assert!(link_data_tunnel(&network, &mut peers, PEER_ID, lane, 10.0).await);
            assert_eq!(
                peers[PEER_ID].data_rendezvous_pending,
                lane == EdgeLane::Bulk
            );
            let (channel, ack) = rx.try_recv().expect("same-turn ACK, no probe round trip");
            assert_eq!(channel, CHANNEL_DATA_HELLO);
            assert_eq!(
                decode_data_handshake_frame(&ack),
                Some((DataHandshakeKind::Ack, nonce))
            );
            assert!(rx.try_recv().is_err());
            assert!(link_data_tunnel(&network, &mut peers, PEER_ID, lane, 11.0).await);
            assert_eq!(
                rx.try_recv().unwrap().1,
                ack,
                "duplicate hello re-ACKs identically"
            );
        }
    }
}

#[tokio::test]
async fn interactive_data_replacement_closes_only_the_resource_gap() {
    let (network, mut peers, _rx) = harness().await;
    let tunnel = network.read().await.edge_bulk[PEER_ID].clone();
    network
        .write()
        .await
        .edge_interactive
        .insert(PEER_ID.into(), tunnel.clone());
    let nonce = [0x47; DATA_HANDSHAKE_NONCE_BYTES];
    let peer = peers.get_mut(PEER_ID).unwrap();
    peer.edge_rebind = Some(connection::EdgeRebindWindow {
        deadline_ms: 1000.0,
        rebinds_used: 2,
    });
    peer.paths.edge.available = false;
    peer.data_attachment_nonces[0] = Some(nonce);
    peer.awaiting_resume_until_ms = Some(0.5);
    peer.resume_waiting_for_data = true;
    peer.needs_snapshot = false;
    assert_eq!(arm_expired_resume_snapshots(&mut peers, 1.0), 0);
    assert!(!link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Interactive, 1.0).await);
    assert!(peers[PEER_ID].is_rebinding());
    tunnel.observe_browser_hello(nonce);
    assert!(link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Interactive, 2.0).await);
    assert!(peers[PEER_ID].has_display_counterpart());
    assert!(!peers[PEER_ID].is_rebinding());
    assert!(peers[PEER_ID].is_e2e_ready());
    assert_eq!(arm_expired_resume_snapshots(&mut peers, 30_000.0), 0);
    assert_eq!(
        compute_next_flush_delay_ms(&peers, pty::PendingDisplayDamage::CLEAN, 0, &[], 30_000.0),
        None,
        "waiting for authenticated DATA must not spin on the old deadline",
    );
    peers
        .get_mut(PEER_ID)
        .unwrap()
        .begin_resume_receive_budget(30_000.0, PeerTransport::Edge);
    let deadline = peers[PEER_ID].awaiting_resume_until_ms.unwrap();
    assert!(deadline > 30_000.0);
    assert!(link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Interactive, 3.0).await);
    peers
        .get_mut(PEER_ID)
        .unwrap()
        .begin_resume_receive_budget(30_100.0, PeerTransport::Edge);
    assert_eq!(peers[PEER_ID].awaiting_resume_until_ms, Some(deadline));
    assert_eq!(arm_expired_resume_snapshots(&mut peers, deadline), 1);
}

#[tokio::test]
async fn wrong_nonce_or_data_generation_cannot_inherit_a_link() {
    let (network, mut peers, mut rx) = harness().await;
    let tunnel = network.read().await.edge_bulk[PEER_ID].clone();
    let nonce = [0x43; DATA_HANDSHAKE_NONCE_BYTES];
    peers.get_mut(PEER_ID).unwrap().data_attachment_nonces[1] = Some(nonce);
    tunnel.observe_browser_hello([0x44; DATA_HANDSHAKE_NONCE_BYTES]);
    assert!(!link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Bulk, 1.0).await);
    assert!(rx.try_recv().is_err());
    tunnel.observe_browser_hello(nonce);
    assert!(link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Bulk, 1.0).await);
    rx.try_recv().unwrap();
    let (tx, mut replacement_rx) = mpsc::unbounded_channel();
    let replacement = Arc::new(edge_tunnel::EdgeTunnel::new_capture(tx));
    network
        .write()
        .await
        .edge_bulk
        .insert(PEER_ID.into(), replacement.clone());
    assert!(!link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Bulk, 2.0).await);
    assert!(replacement_rx.try_recv().is_err());
    replacement.observe_browser_hello(nonce);
    assert!(link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Bulk, 2.0).await);
    assert!(Arc::ptr_eq(
        peers[PEER_ID].edge_tunnel_bulk.as_ref().unwrap(),
        &replacement
    ));
    assert!(!link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Signaling, 2.0).await);
}

#[tokio::test]
async fn browser_hello_replacement_revokes_bulk_receipt_before_its_claim_arrives() {
    let (network, mut peers, mut rx) = harness().await;
    let tunnel = network.read().await.edge_bulk[PEER_ID].clone();
    let incumbent = [0x61; DATA_HANDSHAKE_NONCE_BYTES];
    let successor = [0x62; DATA_HANDSHAKE_NONCE_BYTES];
    peers.get_mut(PEER_ID).unwrap().data_attachment_nonces[1] = Some(incumbent);
    tunnel.observe_browser_hello(incumbent);
    assert!(link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Bulk, 1.0).await);
    rx.try_recv().unwrap();
    assert!(confirm_bulk_delivery(
        peers.get_mut(PEER_ID).unwrap(),
        Some(incumbent)
    ));

    // The durable daemon Arc is unchanged; only the browser attachment moved.
    tunnel.observe_browser_hello(successor);
    assert!(!link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Bulk, 2.0).await);
    assert!(!peers[PEER_ID].bulk_delivery_confirmed);
    assert!(!confirm_bulk_delivery(
        peers.get_mut(PEER_ID).unwrap(),
        Some(incumbent)
    ));
    assert!(!confirm_bulk_delivery(
        peers.get_mut(PEER_ID).unwrap(),
        Some(successor)
    ));
    assert!(rx.try_recv().is_err());

    peers.get_mut(PEER_ID).unwrap().data_attachment_nonces[1] = Some(successor);
    assert!(link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Bulk, 3.0).await);
    rx.try_recv().unwrap();
    assert!(!peers[PEER_ID].bulk_delivery_confirmed);
    assert!(!confirm_bulk_delivery(
        peers.get_mut(PEER_ID).unwrap(),
        Some(incumbent)
    ));
    assert!(confirm_bulk_delivery(
        peers.get_mut(PEER_ID).unwrap(),
        Some(successor)
    ));
}

#[tokio::test]
async fn data_ack_rejection_cannot_confirm_or_revoke_an_admitted_generation() {
    let (network, mut peers, mut rx) = harness().await;
    let tunnel = network.read().await.edge_bulk[PEER_ID].clone();
    let nonce = [0x58; DATA_HANDSHAKE_NONCE_BYTES];
    tunnel.observe_browser_hello(nonce);
    peers.get_mut(PEER_ID).unwrap().data_attachment_nonces[1] = Some(nonce);
    assert!(link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Bulk, 1.0).await);
    rx.try_recv().unwrap();
    drop(rx);
    assert!(
        !peers[PEER_ID].bulk_delivery_confirmed,
        "ACK admission is not downstream proof"
    );
    assert!(!confirm_bulk_delivery(
        peers.get_mut(PEER_ID).unwrap(),
        Some([0x59; DATA_HANDSHAKE_NONCE_BYTES])
    ));
    assert!(confirm_bulk_delivery(
        peers.get_mut(PEER_ID).unwrap(),
        Some(nonce)
    ));
    assert!(!link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Bulk, 2.0).await);
    assert!(peers[PEER_ID].bulk_delivery_confirmed);
    peers.get_mut(PEER_ID).unwrap().bulk_delivery_confirmed = false;
    assert!(!link_data_tunnel(&network, &mut peers, PEER_ID, EdgeLane::Bulk, 3.0).await);
    assert!(!peers[PEER_ID].bulk_delivery_confirmed);
}

#[tokio::test]
async fn final_peer_disconnect_releases_bulk_generation_ownership() {
    const CONNECTION_ID: u64 = 73;
    let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);
    let mut wt_temp_to_real: HashMap<String, Arc<str>> = HashMap::new();
    let wt_state = Some(current_wt_state(PEER_ID, CONNECTION_ID));
    let mut parked = ParkedPeers::new();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    let mut edge_dials = HashMap::from([(
        PEER_ID.to_string(),
        EdgeDialState {
            session_id: "session-1".to_string(),
            pending_request: test_pending_session_request("session-1", 1),
            config: edge_tunnel::EdgeConfig {
                url: "https://edge.example".to_string(),
                admission: edge_tunnel::EdgeAdmission::for_test(),
            },
            signaling: EdgeDialLane {
                generation: 5,
                state: EdgeDialLaneState::Succeeded,
            },
            interactive: EdgeDialLane {
                generation: 1,
                state: EdgeDialLaneState::Succeeded,
            },
            bulk: EdgeDialLane {
                generation: 2,
                state: EdgeDialLaneState::Succeeded,
            },
            lifecycle: EdgeDialLifecycle::default(),
        },
    )]);
    let (event_tx, _event_output) = test_event_sink();

    let mut registry = PeerRegistry {
        peers: std::mem::take(&mut peers),
        input_refill: input::InputRefill::default(),
        parked: std::mem::replace(&mut parked, ParkedPeers::new()),
        edge_dials: std::mem::take(&mut edge_dials),
        wt_temp_to_real: std::mem::take(&mut wt_temp_to_real),
        wt_upgrade_pending: HashMap::new(),
    };

    let path_survived = handle_direct_webtransport_disconnected_event(
        PEER_ID.to_string(),
        CONNECTION_ID,
        "all paths closed".to_string(),
        &mut registry,
        &wt_state,
        &network_state,
        &event_tx,
        Instant::now(),
    )
    .await;

    assert!(!path_survived);
    assert!(!registry.peers.contains_key(PEER_ID));
    assert!(!edge_dials.contains_key(PEER_ID));
}

#[tokio::test]
async fn current_direct_disconnect_requeues_only_its_attempts_before_edge_reoffer() {
    use connection::{SentDatagram, SentPaths, SentRow, SentRows};
    use merkur_codec::CellRepr;

    const CONNECTION_ID: u64 = 74;
    let (edge_tx, _edge_rx) = mpsc::unbounded_channel();
    let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.paths.edge = connection::PathHealth::fresh_available(1.0);
    peer.edge_tunnel = Some(Arc::new(edge_tunnel::EdgeTunnel::new_capture(edge_tx)));
    peer.needs_snapshot = false;
    peer.needs_full_diff = false;
    peer.generation = 19;
    peer.display_dictionary_ready = true;
    peer.last_admitted_critical_header_signal = 0xfeed;
    peer.display_cache.resize(1, 3);
    peer.display_cache
        .prime_from_snapshot(&[CellRepr::BLANK; 3], &[1, 2, 3], &[]);

    let direct_row = SentRow {
        graphics: None,
        row: 0,
        hash: 101,
        cells: vec![CellRepr::BLANK].into(),
    };
    peer.display_cache.record_reliable_sent_rows_on_path(
        10,
        std::slice::from_ref(&direct_row),
        10.0,
        PeerTransport::WebTransport,
        25.0,
    );
    peer.display_cache.insert_sent_datagram(
        10,
        SentDatagram {
            sent_at_ms: 10.0,
            rows: SentRows::from_iter([direct_row]),
            sent_via: SentPaths::single(PeerTransport::WebTransport),
            header_only: false,
            reliable: true,
            protection: crate::connection::DisplayDatagramProtection::Unprotected,
        },
    );

    let edge_row = SentRow {
        graphics: None,
        row: 1,
        hash: 202,
        cells: vec![CellRepr::BLANK].into(),
    };
    let edge_paths = SentPaths::single(PeerTransport::Edge);
    peer.display_cache.record_sent_rows_on_paths(
        11,
        std::slice::from_ref(&edge_row),
        11.0,
        edge_paths,
        25.0,
    );
    peer.display_cache.insert_sent_datagram(
        11,
        SentDatagram {
            sent_at_ms: 11.0,
            rows: SentRows::from_iter([edge_row]),
            sent_via: edge_paths,
            header_only: false,
            reliable: false,
            protection: crate::connection::DisplayDatagramProtection::Unprotected,
        },
    );

    let dual_row = SentRow {
        graphics: None,
        row: 2,
        hash: 303,
        cells: vec![CellRepr::BLANK].into(),
    };
    let dual_paths = SentPaths {
        webtransport: true,
        edge: true,
    };
    peer.display_cache.record_sent_rows_on_paths(
        12,
        std::slice::from_ref(&dual_row),
        12.0,
        dual_paths,
        25.0,
    );
    peer.display_cache.insert_sent_datagram(
        12,
        SentDatagram {
            sent_at_ms: 12.0,
            rows: SentRows::from_iter([dual_row]),
            sent_via: dual_paths,
            header_only: false,
            reliable: false,
            protection: crate::connection::DisplayDatagramProtection::Unprotected,
        },
    );
    peer.display_cache.insert_sent_datagram(
        13,
        SentDatagram {
            sent_at_ms: 13.0,
            rows: SentRows::default(),
            sent_via: dual_paths,
            header_only: true,
            reliable: false,
            protection: crate::connection::DisplayDatagramProtection::Unprotected,
        },
    );

    let wt_state = Some(current_wt_state(PEER_ID, CONNECTION_ID));
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    let (event_tx, _event_output) = test_event_sink();
    let mut registry = PeerRegistry {
        peers: PeerMap::from([(PEER_ID.into(), peer)]),
        input_refill: input::InputRefill::default(),
        parked: ParkedPeers::new(),
        edge_dials: HashMap::new(),
        wt_temp_to_real: HashMap::new(),
        wt_upgrade_pending: HashMap::new(),
    };

    assert!(
        handle_direct_webtransport_disconnected_event(
            PEER_ID.to_string(),
            CONNECTION_ID,
            "direct closed".to_string(),
            &mut registry,
            &wt_state,
            &network_state,
            &event_tx,
            Instant::now(),
        )
        .await,
        "the edge keeps the authenticated peer live"
    );

    let peer = registry.peers.get_mut(PEER_ID).expect("live edge peer");
    assert!(!peer.paths.webtransport.available);
    assert!(peer.paths.edge.available);
    assert_eq!(peer.generation, 19);
    assert!(peer.display_dictionary_ready);
    assert!(!peer.needs_snapshot);
    assert!(peer.needs_full_diff);
    assert_eq!(peer.last_admitted_critical_header_signal, 0xfeed);
    assert_eq!(peer.display_cache.acked_row_hashes, vec![1, 2, 3]);
    assert_eq!(peer.display_cache.sent_row_latest_seq, vec![0, 11, 12]);
    assert!(!peer.display_cache.sent_datagrams.contains_key(&10));
    assert!(peer.display_cache.sent_datagrams.contains_key(&11));
    assert!(peer.display_cache.sent_datagrams.contains_key(&12));
    assert!(peer.display_cache.sent_datagrams.contains_key(&13));
    assert!(peer.display_cache.sent_row_force_full_until_confirmed[0]);

    session::wt_upgrade_flow::admit_direct_path(peer, 200.0, 30.0, false);

    assert!(peer.paths.webtransport.available);
    assert_eq!(peer.paths.webtransport.rtt_ewma_ms, 30.0);
    assert_eq!(peer.generation, 19);
    assert!(peer.display_dictionary_ready);
    assert_eq!(peer.display_cache.sent_row_latest_seq, vec![0, 11, 12]);
    assert!(peer.display_cache.sent_datagrams.contains_key(&11));
    assert!(peer.display_cache.sent_datagrams.contains_key(&12));
    assert!(peer.display_cache.sent_datagrams.contains_key(&13));
}

#[tokio::test]
async fn explicit_disconnect_releases_peer_and_registry_transport_ownership() {
    let (interactive_tx, _interactive_rx) = mpsc::unbounded_channel();
    let (bulk_tx, _bulk_rx) = mpsc::unbounded_channel();
    let interactive = Arc::new(edge_tunnel::EdgeTunnel::new_capture(interactive_tx));
    let bulk = Arc::new(edge_tunnel::EdgeTunnel::new_capture(bulk_tx));
    let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.edge_tunnel = Some(interactive.clone());
    peer.edge_tunnel_bulk = Some(bulk.clone());
    let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);
    let mut edge_dials = HashMap::from([(
        PEER_ID.to_string(),
        EdgeDialState {
            session_id: "session-1".to_string(),
            pending_request: test_pending_session_request("session-1", 1),
            config: edge_tunnel::EdgeConfig {
                url: "https://edge.example".to_string(),
                admission: edge_tunnel::EdgeAdmission::for_test(),
            },
            signaling: EdgeDialLane {
                generation: 5,
                state: EdgeDialLaneState::Succeeded,
            },
            interactive: EdgeDialLane {
                generation: 1,
                state: EdgeDialLaneState::Succeeded,
            },
            bulk: EdgeDialLane {
                generation: 2,
                state: EdgeDialLaneState::Succeeded,
            },
            lifecycle: EdgeDialLifecycle::default(),
        },
    )]);
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    {
        let mut state = network_state.write().await;
        state
            .edge_interactive
            .insert(PEER_ID.to_string(), interactive);
        state.edge_bulk.insert(PEER_ID.to_string(), bulk);
    }
    let (event_tx, _event_output) = test_event_sink();
    let message = PeerMessage {
        input_permit: None,
        peer_node_id: Arc::from(PEER_ID),
        channel_id: CHANNEL_CTRL,
        payload: bytes::Bytes::new(),
        via_transport: PeerTransport::Edge,
        delivery: DeliveryMode::Stream,
        connection_id: 0,
        edge_ingress: None,
    };

    let mut registry = PeerRegistry {
        peers: std::mem::take(&mut peers),
        edge_dials: std::mem::take(&mut edge_dials),
        ..PeerRegistry::new()
    };

    handle_explicit_peer_disconnect(&message, &[1], &mut registry, &network_state, &event_tx).await;

    assert!(!registry.peers.contains_key(PEER_ID));
    assert!(!registry.edge_dials.contains_key(PEER_ID));
    let state = network_state.read().await;
    assert!(!state.edge_interactive.contains_key(PEER_ID));
    assert!(!state.edge_bulk.contains_key(PEER_ID));
}

#[tokio::test]
async fn revocation_closes_registry_only_lanes_and_retires_redial_ownership() {
    let (interactive_tx, _interactive_rx) = mpsc::unbounded_channel();
    let (bulk_tx, _bulk_rx) = mpsc::unbounded_channel();
    let interactive = Arc::new(edge_tunnel::EdgeTunnel::new_capture(interactive_tx));
    let bulk = Arc::new(edge_tunnel::EdgeTunnel::new_capture(bulk_tx));
    // Model the pre-auth ownership gap: the registry owns both lanes while
    // the peer has not linked either Arc yet.
    let peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::WebTransport);
    let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);
    let mut edge_dials = HashMap::from([(
        PEER_ID.to_string(),
        EdgeDialState {
            session_id: "session-1".to_string(),
            pending_request: test_pending_session_request("session-1", 1),
            config: edge_tunnel::EdgeConfig {
                url: "https://edge.example".to_string(),
                admission: edge_tunnel::EdgeAdmission::for_test(),
            },
            signaling: EdgeDialLane {
                generation: 5,
                state: EdgeDialLaneState::Succeeded,
            },
            interactive: EdgeDialLane {
                generation: 1,
                state: EdgeDialLaneState::Succeeded,
            },
            bulk: EdgeDialLane {
                generation: 2,
                state: EdgeDialLaneState::Succeeded,
            },
            lifecycle: EdgeDialLifecycle::default(),
        },
    )]);
    let mut temp_to_real = HashMap::from([("temp".to_string(), Arc::<str>::from(PEER_ID))]);
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    {
        let mut state = network_state.write().await;
        state
            .edge_interactive
            .insert(PEER_ID.to_string(), interactive);
        state.edge_bulk.insert(PEER_ID.to_string(), bulk);
    }

    let mut registry = PeerRegistry {
        peers: std::mem::take(&mut peers),
        edge_dials: std::mem::take(&mut edge_dials),
        wt_temp_to_real: std::mem::take(&mut temp_to_real),
        ..PeerRegistry::new()
    };

    evict_revoked_peer(PEER_ID, &mut registry, &network_state).await;

    assert!(!registry.peers.contains_key(PEER_ID));
    assert!(!registry.edge_dials.contains_key(PEER_ID));
    assert!(registry.wt_temp_to_real.is_empty());
    let state = network_state.read().await;
    assert!(!state.edge_interactive.contains_key(PEER_ID));
    assert!(!state.edge_bulk.contains_key(PEER_ID));
}
