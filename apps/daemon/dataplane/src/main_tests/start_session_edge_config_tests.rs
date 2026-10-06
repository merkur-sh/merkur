use super::*;

fn start_session_payload(session_id: &str, browser_node_id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "command_id": "command-1",
        "user_id": "user-1",
        "delegation_id": "delegation-1",
        "session_id": session_id,
        "browser_node_id": browser_node_id,
        "client_nonce": base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode([3_u8; merkur_e2e::SESSION_NONCE_BYTES]),
        "encapsulation_key": base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode([5_u8; merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES]),
        "edge_wt_url": "https://edge.example",
        "edge_cert_hashes": [
            base64::engine::general_purpose::STANDARD.encode([7_u8; 32])
        ],
    }))
    .unwrap()
}

#[test]
fn start_session_requires_exact_per_session_coordinates() {
    assert!(
        serde_json::from_value::<StartSessionCmd>(serde_json::json!({
            "session_id": "session-1",
            "browser_node_id": "browser-1",
        }))
        .is_err()
    );
}

#[test]
fn start_session_requires_the_browser_identity() {
    assert!(
        serde_json::from_value::<StartSessionCmd>(serde_json::json!({
            "session_id": "session-1",
            "edge_wt_url": "https://edge.example",
            "edge_cert_hashes": [
                base64::engine::general_purpose::STANDARD.encode([7_u8; 32])
            ],
        }))
        .is_err()
    );
}

fn test_edge_config() -> edge_tunnel::EdgeConfig {
    edge_tunnel::EdgeConfig {
        url: "https://edge.example".to_string(),
        admission: edge_tunnel::EdgeAdmission::for_test(),
    }
}

fn attach_for(session_id: &str, generation: EdgeLaneGeneration, lane: EdgeLane) -> EdgeAttach {
    EdgeAttach {
        peer_id: "browser-1".to_string(),
        session_id: session_id.to_string(),
        generation,
        result: Err("not used".to_string()),
        lane,
    }
}

#[test]
fn failed_edge_attach_consumes_one_fallback_until_concrete_rearm() {
    const PEER_ID: &str = "browser-1";
    const SESSION_ID: &str = "session-1";
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let initial = begin_edge_dial(
        &mut dials,
        PEER_ID,
        SESSION_ID,
        &test_pending_session_request(SESSION_ID, 1),
        &test_edge_config(),
        &mut next_generation,
    )
    .interactive
    .unwrap();
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for(SESSION_ID, initial, EdgeLane::Interactive),
        false
    ));

    let fallback = restart_failed_edge_lane(
        &mut dials,
        PEER_ID,
        SESSION_ID,
        EdgeLane::Interactive,
        &mut next_generation,
        false,
    )
    .expect("dial failure owns one immediate replacement");
    assert!(!dials[PEER_ID].lifecycle.interactive_redial_available);
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for(SESSION_ID, fallback.generation, EdgeLane::Interactive),
        false
    ));
    assert!(
        restart_failed_edge_lane(
            &mut dials,
            PEER_ID,
            SESSION_ID,
            EdgeLane::Interactive,
            &mut next_generation,
            false,
        )
        .is_none(),
        "a second failure cannot form an RTT-speed retry loop"
    );

    let rearmed = rearm_failed_edge_lanes_for_peer(&mut dials, PEER_ID, &mut next_generation);
    assert_eq!(rearmed.len(), 1);
    assert_eq!(rearmed[0].lane, EdgeLane::Interactive);
    assert_eq!(dials[PEER_ID].interactive.state, EdgeDialLaneState::Pending);
}

fn edge_message(
    session_id: &str,
    generation: EdgeLaneGeneration,
    lane: EdgeLane,
    channel_id: u8,
) -> PeerMessage {
    PeerMessage {
        input_permit: None,
        peer_node_id: Arc::from("browser-1"),
        channel_id,
        payload: bytes::Bytes::new(),
        via_transport: PeerTransport::Edge,
        delivery: DeliveryMode::Stream,
        connection_id: generation,
        edge_ingress: Some(EdgeIngressIdentity {
            session_id: Arc::from(session_id),
            generation,
            lane,
        }),
    }
}

fn capture_tunnel() -> (
    Arc<edge_tunnel::EdgeTunnel>,
    mpsc::UnboundedReceiver<(u8, Vec<u8>)>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Arc::new(edge_tunnel::EdgeTunnel::new_capture(tx)), rx)
}

struct CancelHarness {
    cancelled: CancelledSessions,
    registry: PeerRegistry,
    network_state: Arc<RwLock<NetworkState>>,
    wt_state: Option<Arc<RwLock<WebTransportState>>>,
    event_tx: EventSink,
    _event_output: EventOutput,
}

impl CancelHarness {
    fn new() -> Self {
        let (event_tx, event_output) = test_event_sink();
        Self {
            cancelled: CancelledSessions::default(),
            registry: PeerRegistry::new(),
            network_state: Arc::new(RwLock::new(NetworkState::new())),
            wt_state: None,
            event_tx,
            _event_output: event_output,
        }
    }

    async fn cancel(
        &mut self,
        browser_node_id: &str,
        session_id: &str,
        now_ms: f64,
    ) -> SessionCancelOutcome {
        let payload = serde_json::to_vec(&serde_json::json!({
            "command_id": "command-1",
            "browser_node_id": browser_node_id,
            "session_id": session_id,
        }))
        .unwrap();
        handle_cancel_session(
            &payload,
            &mut self.cancelled,
            &mut self.registry,
            &self.network_state,
            &self.wt_state,
            &self.event_tx,
            now_ms,
        )
        .await
    }
}

fn succeeded_dial(session_id: &str) -> EdgeDialState {
    EdgeDialState {
        session_id: session_id.to_string(),
        pending_request: test_pending_session_request(session_id, 1),
        config: test_edge_config(),
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
    }
}

#[tokio::test]
async fn relay_data_budget_close_pauses_without_parking_and_resume_redials_only_paused() {
    let peer_id = "paused-peer";
    let mut dials = HashMap::from([(peer_id.to_string(), succeeded_dial("pause"))]);
    let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.paths.webtransport.available = true;
    peer.edge_rebind = Some(connection::EdgeRebindWindow {
        deadline_ms: 200_000.0,
        rebinds_used: 0,
    });
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);
    let network = Arc::new(RwLock::new(NetworkState::new()));
    let (tunnel, _data_rx) = capture_tunnel();
    let (signaling, _signaling_rx) = capture_tunnel();
    network::register_edge_signaling(&network, peer_id, signaling.clone()).await;
    network::register_edge_interactive(&network, peer_id, tunnel.clone()).await;
    let mut next = 10;
    let action = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: peer_id.into(),
            session_id: "pause".into(),
            generation: 1,
            lane: EdgeLane::Interactive,
            tunnel,
            close_reason: edge_tunnel::EdgeTunnelCloseReason::EgressBudget,
        },
        &mut dials,
        &mut next,
        &mut peers,
        &network,
        true,
        1.0,
    )
    .await;
    assert!(!action.park_peer);
    assert!(action.redial.is_none());
    assert!(signaling.relay_data_is_paused());
    assert_eq!(dials[peer_id].interactive.state, EdgeDialLaneState::Paused);
    assert_eq!(dials[peer_id].bulk.state, EdgeDialLaneState::Paused);
    assert!(peers[peer_id].paths.webtransport.available);
    assert!(peers[peer_id].edge_rebind.is_none());
    // Even an independently armed recovery window cannot select paused lanes.
    peers.get_mut(peer_id).unwrap().edge_rebind = Some(connection::EdgeRebindWindow {
        deadline_ms: 200_000.0,
        rebinds_used: 0,
    });
    dials.get_mut(peer_id).unwrap().lifecycle.redial_due_at_ms = Some(2.0);
    assert!(take_due_edge_redials(&mut dials, &peers, 100_000.0, &mut next).is_empty());
    let requests =
        set_relay_data_paused(dials.get_mut(peer_id).unwrap(), peer_id, false, &mut next);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].lane, EdgeLane::Interactive);
    assert_eq!(requests[1].lane, EdgeLane::Bulk);
    assert_eq!(requests[0].generation, 11);
    assert_eq!(requests[1].generation, 12);
    assert_eq!(dials[peer_id].signaling.generation, 5);
    assert!(
        set_relay_data_paused(dials.get_mut(peer_id).unwrap(), peer_id, false, &mut next)
            .is_empty()
    );
}

fn begin_leased_edge_dial(
    dials: &mut HashMap<String, EdgeDialState>,
    peer_id: &str,
    session_id: &str,
    now_ms: f64,
    next_generation: &mut EdgeLaneGeneration,
) -> EdgeDialPlan {
    let plan = begin_edge_dial(
        dials,
        peer_id,
        session_id,
        &test_pending_session_request(session_id, 1),
        &test_edge_config(),
        next_generation,
    );
    assert!(arm_new_edge_preauth_lease(
        dials, peer_id, session_id, now_ms
    ));
    plan
}

#[tokio::test]
async fn cancel_before_late_start_rejects_only_the_exact_tuple() {
    let mut harness = CancelHarness::new();
    let outcome = harness.cancel("browser-1", "session-1", 100.0).await;
    assert_eq!(
        outcome,
        SessionCancelOutcome {
            tombstoned: true,
            ..SessionCancelOutcome::default()
        }
    );
    assert!(harness.cancelled.contains("browser-1", "session-1", 101.0));
    assert!(
        !harness.cancelled.contains("browser-1", "session-2", 101.0),
        "a replacement session remains admissible"
    );

    let (attach_tx, _attach_rx) = mpsc::channel(1);
    let mut next_generation = 0;
    let payload = start_session_payload("session-1", "browser-1");
    handle_start_session(
        &mut harness.registry.edge_dials,
        &mut harness.cancelled,
        &mut next_generation,
        &attach_tx,
        &edge_tunnel::EdgeAdmission::for_test(),
        &harness.event_tx,
        &payload,
        101.0,
    );
    assert!(harness.registry.edge_dials.is_empty());
    assert_eq!(next_generation, 0, "late start allocated no lane owner");
}

#[tokio::test]
async fn start_then_cancel_retires_both_exact_dial_lanes() {
    let mut harness = CancelHarness::new();
    harness
        .registry
        .edge_dials
        .insert("browser-1".to_string(), succeeded_dial("session-1"));
    let (interactive, _interactive_rx) = capture_tunnel();
    let (bulk, _bulk_rx) = capture_tunnel();
    {
        let mut network = harness.network_state.write().await;
        network
            .edge_interactive
            .insert("browser-1".to_string(), interactive);
        network.edge_bulk.insert("browser-1".to_string(), bulk);
    }

    let outcome = harness.cancel("browser-1", "session-1", 100.0).await;
    assert!(outcome.dial_retired);
    assert!(!outcome.active_retired);
    assert!(!harness.registry.edge_dials.contains_key("browser-1"));
    let network = harness.network_state.read().await;
    assert!(!network.edge_interactive.contains_key("browser-1"));
    assert!(!network.edge_bulk.contains_key("browser-1"));
}

#[tokio::test]
async fn cancelling_pending_replacement_does_not_close_predecessor_lanes() {
    let mut harness = CancelHarness::new();
    let (predecessor_interactive, _interactive_rx) = capture_tunnel();
    let (predecessor_bulk, _bulk_rx) = capture_tunnel();
    let mut predecessor = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    predecessor.authenticated = true;
    predecessor.signal_session_id = "session-1".to_string();
    predecessor.edge_tunnel = Some(predecessor_interactive.clone());
    predecessor.edge_tunnel_bulk = Some(predecessor_bulk.clone());
    harness
        .registry
        .peers
        .insert("browser-1".into(), predecessor);
    harness.registry.edge_dials.insert(
        "browser-1".to_string(),
        EdgeDialState {
            session_id: "session-2".to_string(),
            pending_request: test_pending_session_request("session-2", 1),
            config: test_edge_config(),
            signaling: EdgeDialLane {
                generation: 5,
                state: EdgeDialLaneState::Pending,
            },
            interactive: EdgeDialLane {
                generation: 3,
                state: EdgeDialLaneState::Pending,
            },
            bulk: EdgeDialLane {
                generation: 4,
                state: EdgeDialLaneState::Pending,
            },
            lifecycle: EdgeDialLifecycle::default(),
        },
    );
    {
        let mut network = harness.network_state.write().await;
        network
            .edge_interactive
            .insert("browser-1".to_string(), predecessor_interactive.clone());
        network
            .edge_bulk
            .insert("browser-1".to_string(), predecessor_bulk.clone());
    }

    let outcome = harness.cancel("browser-1", "session-2", 100.0).await;
    assert!(outcome.dial_retired);
    assert!(!outcome.active_retired);
    assert!(harness.registry.peers.contains_key("browser-1"));
    let network = harness.network_state.read().await;
    assert!(Arc::ptr_eq(
        network.edge_interactive.get("browser-1").unwrap(),
        &predecessor_interactive,
    ));
    assert!(Arc::ptr_eq(
        network.edge_bulk.get("browser-1").unwrap(),
        &predecessor_bulk,
    ));
}

#[tokio::test]
async fn cancel_before_noise_completion_parks_display_continuity() {
    let mut harness = CancelHarness::new();
    let (interactive, _interactive_rx) = capture_tunnel();
    let (bulk, _bulk_rx) = capture_tunnel();
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.signal_session_id = "session-1".to_string();
    peer.display_cache.resize(2, 1);
    peer.display_cache.initialized = true;
    peer.edge_tunnel = Some(interactive.clone());
    peer.edge_tunnel_bulk = Some(bulk.clone());
    harness.registry.peers.insert("browser-1".into(), peer);
    harness
        .registry
        .edge_dials
        .insert("browser-1".to_string(), succeeded_dial("session-1"));
    harness
        .registry
        .peers
        .get_mut("browser-1")
        .expect("active peer is present")
        .latest_input_seq = 9;
    harness
        .registry
        .wt_temp_to_real
        .insert("temp-1".to_string(), Arc::from("browser-1"));
    {
        let mut network = harness.network_state.write().await;
        network
            .edge_interactive
            .insert("browser-1".to_string(), interactive);
        network.edge_bulk.insert("browser-1".to_string(), bulk);
    }

    let outcome = harness.cancel("browser-1", "session-1", 100.0).await;
    assert!(outcome.active_retired);
    assert!(outcome.dial_retired);
    assert!(!harness.registry.peers.contains_key("browser-1"));
    // The carriers and keys are gone; the display cache and input counters
    // are parked for the successor issuance the same cancel usually precedes.
    assert_eq!(harness.registry.parked.len(), 1, "an active cancel parks");
    let parked = harness
        .registry
        .parked
        .take("browser-1")
        .expect("cancelled active peer is parked");
    assert!(parked.display_cache.initialized);
    assert_eq!(parked.latest_input_seq, 9);
    assert!(parked.edge_tunnel.is_none() && parked.edge_tunnel_bulk.is_none());
    assert!(parked.noise.is_none());
    assert!(harness.registry.wt_temp_to_real.is_empty());
    let network = harness.network_state.read().await;
    assert!(!network.edge_interactive.contains_key("browser-1"));
    assert!(!network.edge_bulk.contains_key("browser-1"));
}

#[tokio::test]
async fn cancel_after_noise_completion_cannot_retire_or_tombstone_the_session() {
    let mut harness = CancelHarness::new();
    let (mut peer, _browser) = super::e2e_dispatch_tests::authenticated_e2e_peer("browser-1");
    peer.signal_session_id = "session-1".to_string();
    peer.latest_input_seq = 9;
    harness.registry.peers.insert("browser-1".into(), peer);
    harness
        .registry
        .edge_dials
        .insert("browser-1".to_string(), succeeded_dial("session-1"));

    for now_ms in [100.0, 200.0] {
        let outcome = harness.cancel("browser-1", "session-1", now_ms).await;
        assert_eq!(outcome, SessionCancelOutcome::default());
        assert!(!harness.cancelled.contains("browser-1", "session-1", now_ms));
        let peer = &harness.registry.peers["browser-1"];
        assert!(peer.noise.is_some());
        assert_eq!(peer.latest_input_seq, 9);
        assert!(harness.registry.edge_dials.contains_key("browser-1"));
        assert_eq!(harness.registry.parked.len(), 0);
    }
}

#[tokio::test]
async fn exact_parked_cancel_keeps_resume_continuity() {
    let mut harness = CancelHarness::new();
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.signal_session_id = "session-1".to_string();
    peer.display_cache.resize(2, 1);
    peer.display_cache.initialized = true;
    park_disconnected_peer(&mut harness.registry.parked, peer, 50.0);
    assert_eq!(harness.registry.parked.len(), 1);

    // A cancel names a session; parked state belongs to the browser identity
    // and carries no session anything could resume. Leaving it alone is what
    // lets the successor issuance -- the usual reason for the cancel -- splice
    // it, and what keeps a cancel from ever enqueueing a peer-id-only
    // teardown that could reach a newer replacement session.
    let outcome = harness.cancel("browser-1", "session-1", 100.0).await;
    assert!(!outcome.active_retired);
    assert!(!outcome.dial_retired);
    assert_eq!(harness.registry.parked.len(), 1);
    assert!(harness.registry.parked.take_removed_peer_ids().is_empty());
}

#[tokio::test]
async fn stale_cancel_after_replacement_is_transport_noop() {
    let mut harness = CancelHarness::new();
    let (interactive, _interactive_rx) = capture_tunnel();
    let (bulk, _bulk_rx) = capture_tunnel();
    let mut replacement = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    replacement.authenticated = true;
    replacement.signal_session_id = "session-2".to_string();
    replacement.edge_tunnel = Some(interactive.clone());
    replacement.edge_tunnel_bulk = Some(bulk.clone());
    harness
        .registry
        .peers
        .insert("browser-1".into(), replacement);
    harness
        .registry
        .edge_dials
        .insert("browser-1".to_string(), succeeded_dial("session-2"));
    harness
        .registry
        .peers
        .get_mut("browser-1")
        .expect("replacement peer is present")
        .latest_input_seq = 17;
    {
        let mut network = harness.network_state.write().await;
        network
            .edge_interactive
            .insert("browser-1".to_string(), interactive.clone());
        network
            .edge_bulk
            .insert("browser-1".to_string(), bulk.clone());
    }

    let outcome = harness.cancel("browser-1", "session-1", 100.0).await;
    assert_eq!(
        outcome,
        SessionCancelOutcome {
            tombstoned: true,
            ..SessionCancelOutcome::default()
        }
    );
    assert_eq!(
        harness.registry.peers["browser-1"].signal_session_id,
        "session-2"
    );
    assert_eq!(
        harness.registry.edge_dials["browser-1"].session_id,
        "session-2"
    );
    assert_eq!(
        harness.registry.peers["browser-1"].latest_input_seq, 17,
        "a stale cancel must not disturb the replacement session's confirmed input high-water"
    );
    let network = harness.network_state.read().await;
    assert!(Arc::ptr_eq(
        network.edge_interactive.get("browser-1").unwrap(),
        &interactive
    ));
    assert!(Arc::ptr_eq(
        network.edge_bulk.get("browser-1").unwrap(),
        &bulk
    ));
}

#[tokio::test]
async fn stale_cancel_cannot_cross_a_replacement_dial_before_reauth() {
    let mut harness = CancelHarness::new();
    let (replacement_tunnel, _replacement_rx) = capture_tunnel();
    // session_start for session-2 has won ownership and linked its tunnel,
    // but the owner loop has not processed replacement auth yet, so the
    // PeerDisplayState still names session-1.
    let mut old_peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    old_peer.authenticated = true;
    old_peer.signal_session_id = "session-1".to_string();
    old_peer.edge_tunnel = Some(replacement_tunnel.clone());
    harness.registry.peers.insert("browser-1".into(), old_peer);
    harness
        .registry
        .edge_dials
        .insert("browser-1".to_string(), succeeded_dial("session-2"));
    harness
        .network_state
        .write()
        .await
        .edge_interactive
        .insert("browser-1".to_string(), replacement_tunnel.clone());

    let outcome = harness.cancel("browser-1", "session-1", 100.0).await;
    assert_eq!(
        outcome,
        SessionCancelOutcome {
            tombstoned: true,
            ..SessionCancelOutcome::default()
        }
    );
    assert!(harness.registry.peers.contains_key("browser-1"));
    assert_eq!(
        harness.registry.edge_dials["browser-1"].session_id,
        "session-2"
    );
    let network = harness.network_state.read().await;
    assert!(Arc::ptr_eq(
        network.edge_interactive.get("browser-1").unwrap(),
        &replacement_tunnel,
    ));
}

#[test]
fn cancellation_tombstones_are_bounded_and_expire() {
    let mut cancelled = CancelledSessions::default();
    for index in 0..=CANCELLED_SESSION_TOMBSTONE_CAP {
        cancelled.insert("browser-1", &format!("session-{index}"), index as f64);
    }
    assert_eq!(cancelled.len(), CANCELLED_SESSION_TOMBSTONE_CAP);
    assert!(cancelled.contains(
        "browser-1",
        &format!("session-{}", CANCELLED_SESSION_TOMBSTONE_CAP),
        CANCELLED_SESSION_TOMBSTONE_CAP as f64,
    ));
    assert!(!cancelled.contains(
        "browser-1",
        &format!("session-{}", CANCELLED_SESSION_TOMBSTONE_CAP),
        CANCELLED_SESSION_TOMBSTONE_CAP as f64 + CANCELLED_SESSION_TOMBSTONE_TTL_MS,
    ));
}

#[tokio::test]
async fn preauth_lease_expires_exactly_and_stale_completions_cannot_resurrect() {
    const PEER_ID: &str = "leased-browser";
    const SESSION_ID: &str = "leased-session";
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_leased_edge_dial(&mut dials, PEER_ID, SESSION_ID, 10.0, &mut next_generation);
    let interactive = plan.interactive.expect("interactive generation");
    let bulk = plan.bulk.expect("bulk generation");
    let owner = next_edge_preauth_deadline(&dials).expect("lease owner");

    assert!(take_expired_edge_preauth(&mut dials, owner.lease.expires_at_ms - 0.001).is_empty());
    let retired = take_expired_edge_preauth(&mut dials, owner.lease.expires_at_ms);
    assert_eq!(retired.len(), 1, "the exact cutoff retires the owner");
    assert!(dials.is_empty());

    assert!(!accept_edge_attach(
        &mut dials,
        &attach_for(SESSION_ID, interactive, EdgeLane::Interactive),
        true,
    ));
    assert!(!accept_edge_attach(
        &mut dials,
        &attach_for(SESSION_ID, bulk, EdgeLane::Bulk),
        true,
    ));

    let (tunnel, _capture_rx) = capture_tunnel();
    let action = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: PEER_ID.to_string(),
            session_id: SESSION_ID.to_string(),
            generation: interactive,
            lane: EdgeLane::Interactive,
            tunnel,
            close_reason: edge_tunnel::EdgeTunnelCloseReason::Other,
        },
        &mut dials,
        &mut next_generation,
        &mut HashMap::new(),
        &Arc::new(RwLock::new(NetworkState::new())),
        true,
        0.0,
    )
    .await;
    assert!(
        action.is_none(),
        "late close completion has no owner to redial"
    );
}

#[test]
fn replacement_lease_generation_rejects_the_predecessor_deadline() {
    const PEER_ID: &str = "replacement-browser";
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    begin_leased_edge_dial(&mut dials, PEER_ID, "session-1", 0.0, &mut next_generation);
    let stale_owner = next_edge_preauth_deadline(&dials).expect("old owner");

    begin_leased_edge_dial(
        &mut dials,
        PEER_ID,
        "session-2",
        EDGE_PREAUTH_LEASE_TTL_MS - 1.0,
        &mut next_generation,
    );
    let replacement_owner = next_edge_preauth_deadline(&dials).expect("replacement owner");
    assert_ne!(
        stale_owner.lease.generation,
        replacement_owner.lease.generation
    );
    assert!(
        retire_edge_preauth_if_current(&mut dials, &stale_owner, stale_owner.lease.expires_at_ms,)
            .is_none()
    );
    assert_eq!(dials[PEER_ID].session_id, "session-2");

    let retired = retire_edge_preauth_if_current(
        &mut dials,
        &replacement_owner,
        replacement_owner.lease.expires_at_ms,
    )
    .expect("replacement expires only at its own cutoff");
    assert_eq!(retired.state.session_id, "session-2");
    assert!(dials.is_empty());
}

#[tokio::test]
async fn expiring_pending_replacement_preserves_authenticated_predecessor_lanes() {
    const PEER_ID: &str = "predecessor-browser";
    let (predecessor_interactive, _interactive_rx) = capture_tunnel();
    let (predecessor_bulk, _bulk_rx) = capture_tunnel();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    {
        let mut network = network_state.write().await;
        network
            .edge_interactive
            .insert(PEER_ID.to_string(), predecessor_interactive.clone());
        network
            .edge_bulk
            .insert(PEER_ID.to_string(), predecessor_bulk.clone());
    }
    let mut predecessor = PeerDisplayState::new(PEER_ID.into(), PeerTransport::WebTransport);
    predecessor.authenticated = true;
    predecessor.signal_session_id = "session-1".to_string();
    predecessor.edge_tunnel = Some(predecessor_interactive.clone());
    predecessor.edge_tunnel_bulk = Some(predecessor_bulk.clone());
    predecessor.latest_input_seq = 17;
    let mut registry = PeerRegistry::new();
    registry.peers.insert(PEER_ID.into(), predecessor);

    let mut next_generation = 0;
    begin_leased_edge_dial(
        &mut registry.edge_dials,
        PEER_ID,
        "session-2",
        0.0,
        &mut next_generation,
    );
    let expired = take_expired_edge_preauth(&mut registry.edge_dials, EDGE_PREAUTH_LEASE_TTL_MS);
    retire_edge_preauth_ownership(expired, &mut registry.peers, &network_state).await;

    assert!(registry.peers.contains_key(PEER_ID));
    assert_eq!(
        registry.peers[PEER_ID].latest_input_seq, 17,
        "retiring an expired pre-auth lease must not disturb the active peer's input high-water"
    );
    let network = network_state.read().await;
    assert!(
        network
            .edge_interactive
            .get(PEER_ID)
            .is_some_and(|lane| Arc::ptr_eq(lane, &predecessor_interactive))
    );
    assert!(
        network
            .edge_bulk
            .get(PEER_ID)
            .is_some_and(|lane| Arc::ptr_eq(lane, &predecessor_bulk))
    );
}

#[tokio::test]
async fn preauth_admission_is_capped_without_counting_two_lanes() {
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    for index in 0..EDGE_PREAUTH_LEASE_CAP {
        let peer_id = format!("browser-{index}");
        let session_id = format!("session-{index}");
        assert!(edge_preauth_capacity_available(
            &dials,
            &peer_id,
            &session_id
        ));
        begin_leased_edge_dial(
            &mut dials,
            &peer_id,
            &session_id,
            index as f64,
            &mut next_generation,
        );
    }
    assert_eq!(edge_preauth_owner_count(&dials), EDGE_PREAUTH_LEASE_CAP);
    assert_eq!(dials.len(), EDGE_PREAUTH_LEASE_CAP);
    assert!(!edge_preauth_capacity_available(
        &dials,
        "browser-over-cap",
        "session-over-cap",
    ));
    let generation_at_capacity = next_generation;
    let (attach_tx, _attach_rx) = mpsc::channel(1);
    let (event_tx, _event_output) = test_event_sink();
    let mut cancelled = CancelledSessions::default();
    let payload = start_session_payload("session-over-cap", "browser-over-cap");
    assert!(!handle_start_session(
        &mut dials,
        &mut cancelled,
        &mut next_generation,
        &attach_tx,
        &edge_tunnel::EdgeAdmission::for_test(),
        &event_tx,
        &payload,
        100.0,
    ));
    assert_eq!(
        next_generation, generation_at_capacity,
        "rejected admission allocates no lane generations"
    );
    assert!(!dials.contains_key("browser-over-cap"));
    assert!(
        edge_preauth_capacity_available(&dials, "browser-0", "replacement-session"),
        "same-peer replacement keeps pre-auth owner count flat"
    );

    dials.get_mut("browser-0").unwrap().lifecycle.preauth_lease = None;
    begin_leased_edge_dial(
        &mut dials,
        "browser-extra",
        "session-extra",
        100.0,
        &mut next_generation,
    );
    assert_eq!(edge_preauth_owner_count(&dials), EDGE_PREAUTH_LEASE_CAP);
    assert!(
        !edge_preauth_capacity_available(&dials, "browser-0", "replacement-session"),
        "an authenticated owner cannot be converted back to pre-auth above the cap"
    );
}

#[test]
fn auth_release_requires_positive_exact_signaling_generation() {
    const PEER_ID: &str = "browser-1";
    const SESSION_ID: &str = "auth-session";
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_leased_edge_dial(&mut dials, PEER_ID, SESSION_ID, 0.0, &mut next_generation);
    let signaling = plan.signaling.expect("signaling generation");
    let bulk = plan.bulk.expect("bulk generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for(SESSION_ID, signaling, EdgeLane::Signaling),
        true,
    ));
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for(SESSION_ID, bulk, EdgeLane::Bulk),
        true,
    ));

    let ingress = |session_id: &str, generation, bulk| EdgeIngressIdentity {
        session_id: Arc::from(session_id),
        generation,
        lane: if bulk {
            EdgeLane::Bulk
        } else {
            EdgeLane::Signaling
        },
    };
    assert!(!release_edge_preauth_lease(
        &mut dials,
        PEER_ID,
        Some(&ingress(SESSION_ID, signaling, false)),
        false,
    ));
    assert!(!release_edge_preauth_lease(
        &mut dials,
        PEER_ID,
        Some(&ingress("stale-session", signaling, false)),
        true,
    ));
    assert!(!release_edge_preauth_lease(
        &mut dials,
        PEER_ID,
        Some(&ingress(SESSION_ID, signaling.wrapping_add(1), false)),
        true,
    ));
    assert!(!release_edge_preauth_lease(
        &mut dials,
        PEER_ID,
        Some(&ingress(SESSION_ID, bulk, true)),
        true,
    ));
    assert!(dials[PEER_ID].lifecycle.preauth_lease.is_some());

    assert!(release_edge_preauth_lease(
        &mut dials,
        PEER_ID,
        Some(&ingress(SESSION_ID, signaling, false)),
        true,
    ));
    assert!(dials[PEER_ID].lifecycle.preauth_lease.is_none());
    assert!(
        take_expired_edge_preauth(&mut dials, EDGE_PREAUTH_LEASE_TTL_MS + 1.0).is_empty(),
        "authenticated ownership is governed by liveness/resumption, not pre-auth TTL"
    );
}

#[test]
fn auth_and_lease_deadline_have_single_owner_first_wins_semantics() {
    const PEER_ID: &str = "browser-1";
    const SESSION_ID: &str = "deadline-session";

    let setup = || {
        let mut dials = HashMap::new();
        let mut next_generation = 0;
        let plan =
            begin_leased_edge_dial(&mut dials, PEER_ID, SESSION_ID, 0.0, &mut next_generation);
        let signaling = plan.signaling.expect("signaling generation");
        assert!(accept_edge_attach(
            &mut dials,
            &attach_for(SESSION_ID, signaling, EdgeLane::Signaling),
            true,
        ));
        (dials, signaling)
    };

    let (mut auth_wins, auth_generation) = setup();
    let auth_ingress = EdgeIngressIdentity {
        session_id: Arc::from(SESSION_ID),
        generation: auth_generation,
        lane: EdgeLane::Signaling,
    };
    assert!(release_edge_preauth_lease(
        &mut auth_wins,
        PEER_ID,
        Some(&auth_ingress),
        true,
    ));
    assert!(
        take_expired_edge_preauth(&mut auth_wins, EDGE_PREAUTH_LEASE_TTL_MS).is_empty(),
        "an auth completion selected first at the cutoff transfers ownership"
    );

    let (mut timeout_wins, timeout_generation) = setup();
    assert_eq!(
        take_expired_edge_preauth(&mut timeout_wins, EDGE_PREAUTH_LEASE_TTL_MS).len(),
        1
    );
    let late_auth = EdgeIngressIdentity {
        session_id: Arc::from(SESSION_ID),
        generation: timeout_generation,
        lane: EdgeLane::Signaling,
    };
    assert!(
        !release_edge_preauth_lease(&mut timeout_wins, PEER_ID, Some(&late_auth), true,),
        "a timeout selected first makes the same-timestamp auth stale"
    );
}

#[test]
fn stale_and_duplicate_lane_results_cannot_replace_the_current_session() {
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_edge_dial(
        &mut dials,
        "browser-1",
        "new-session",
        &test_pending_session_request("new-session", 1),
        &test_edge_config(),
        &mut next_generation,
    );
    let interactive = plan.interactive.expect("interactive generation");
    let bulk = plan.bulk.expect("bulk generation");

    assert!(!accept_edge_attach(
        &mut dials,
        &attach_for("old-session", interactive, EdgeLane::Interactive),
        true,
    ));
    assert!(!accept_edge_attach(
        &mut dials,
        &attach_for(
            "new-session",
            interactive.wrapping_add(99),
            EdgeLane::Interactive
        ),
        true,
    ));
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("new-session", bulk, EdgeLane::Bulk),
        true,
    ));
    assert!(!accept_edge_attach(
        &mut dials,
        &attach_for("new-session", bulk, EdgeLane::Bulk),
        true,
    ));
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("new-session", interactive, EdgeLane::Interactive),
        true,
    ));
    assert!(!accept_edge_attach(
        &mut dials,
        &attach_for("new-session", interactive, EdgeLane::Interactive),
        true,
    ));
}

#[tokio::test]
async fn queued_edge_messages_require_current_lanes_and_bulk_signaling_never_dispatches() {
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let config = test_edge_config();
    let first = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-1",
        &test_pending_session_request("session-1", 1),
        &config,
        &mut next_generation,
    );
    let old_signaling = first.signaling.expect("signaling generation");
    let old_bulk = first.bulk.expect("bulk generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", old_signaling, EdgeLane::Signaling),
        true,
    ));
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", old_bulk, EdgeLane::Bulk),
        true,
    ));

    let stale_signaling = edge_message(
        "session-1",
        old_signaling,
        EdgeLane::Signaling,
        CHANNEL_SIGNALING,
    );
    let stale_bulk_hello = edge_message("session-1", old_bulk, EdgeLane::Bulk, CHANNEL_DATA_HELLO);
    let replacement = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-2",
        &test_pending_session_request("session-2", 2),
        &config,
        &mut next_generation,
    );
    let new_signaling = replacement.signaling.expect("replacement signaling");
    let new_bulk = replacement.bulk.expect("replacement bulk");

    let mut dispatched_signaling = false;
    let mut dispatched_bulk_hello = false;
    for message in [&stale_signaling, &stale_bulk_hello] {
        if is_current_ingress_generation(
            &None,
            &dials,
            "browser-1",
            message.via_transport,
            message.connection_id,
            message.edge_ingress.as_ref(),
        )
        .await
        {
            dispatched_signaling |= message.channel_id == CHANNEL_SIGNALING;
            dispatched_bulk_hello |= message.channel_id == CHANNEL_DATA_HELLO;
        }
    }
    assert!(
        !dispatched_signaling && !dispatched_bulk_hello,
        "queued old-session work is rejected before either dispatch mutation"
    );

    for message in [
        edge_message(
            "session-2",
            new_signaling,
            EdgeLane::Signaling,
            CHANNEL_SIGNALING,
        ),
        edge_message("session-2", new_bulk, EdgeLane::Bulk, CHANNEL_DATA_HELLO),
    ] {
        assert!(
            !is_current_ingress_generation(
                &None,
                &dials,
                "browser-1",
                message.via_transport,
                message.connection_id,
                message.edge_ingress.as_ref(),
            )
            .await,
            "a generation is not ingress-current until its attach succeeds"
        );
    }

    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-2", new_signaling, EdgeLane::Signaling),
        true,
    ));
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-2", new_bulk, EdgeLane::Bulk),
        true,
    ));
    for message in [
        edge_message(
            "session-2",
            new_signaling,
            EdgeLane::Signaling,
            CHANNEL_SIGNALING,
        ),
        edge_message("session-2", new_bulk, EdgeLane::Bulk, CHANNEL_DATA_HELLO),
    ] {
        assert!(
            is_current_ingress_generation(
                &None,
                &dials,
                "browser-1",
                message.via_transport,
                message.connection_id,
                message.edge_ingress.as_ref(),
            )
            .await
        );
    }

    let signaling_signaling = edge_message(
        "session-2",
        new_signaling,
        EdgeLane::Signaling,
        CHANNEL_SIGNALING,
    );
    let bulk_signaling = edge_message("session-2", new_bulk, EdgeLane::Bulk, CHANNEL_SIGNALING);
    assert!(is_signaling_message(&signaling_signaling));
    assert!(
        is_current_ingress_generation(
            &None,
            &dials,
            "browser-1",
            bulk_signaling.via_transport,
            bulk_signaling.connection_id,
            bulk_signaling.edge_ingress.as_ref(),
        )
        .await,
        "the regression requires a current succeeded bulk generation"
    );
    assert!(
        !is_signaling_message(&bulk_signaling),
        "bulk signaling must be dropped before auth or replay-claim dispatch"
    );
}

#[tokio::test(start_paused = true)]
async fn heartbeat_expiry_retires_both_edge_lanes_before_the_next_owner_event() {
    const PEER_ID: &str = "expired-browser";
    const SESSION_ID: &str = "expired-session";
    let mut parked = ParkedPeers::new();
    let mut parked_peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::WebTransport);
    parked_peer.authenticated = true;
    parked_peer.display_cache.resize(2, 1);
    parked_peer.display_cache.initialized = true;
    park_disconnected_peer(&mut parked, parked_peer, 0.0);

    let (interactive, _interactive_rx) = capture_tunnel();
    let (bulk, _bulk_rx) = capture_tunnel();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    {
        let mut state = network_state.write().await;
        state
            .edge_interactive
            .insert(PEER_ID.to_string(), interactive.clone());
        state.edge_bulk.insert(PEER_ID.to_string(), bulk);
    }
    let mut edge_dials = HashMap::from([(
        PEER_ID.to_string(),
        EdgeDialState {
            session_id: SESSION_ID.to_string(),
            pending_request: test_pending_session_request(SESSION_ID, 1),
            config: test_edge_config(),
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
    let mut registry = PeerRegistry::new();
    registry.edge_dials = std::mem::take(&mut edge_dials);
    registry.parked = std::mem::replace(&mut parked, ParkedPeers::new());
    let wt_state = None;
    let (event_tx, _event_output) = test_event_sink();
    let mut rebind_telemetry = session::rebind_flow::RebindTelemetry::new(event_tx.clone());
    let start_instant = Instant::now()
        - Duration::from_millis(session::policy::SessionPolicy::PARKED_PEER_TTL_MS + 1);

    // Production expiry is heartbeat-driven. A paused Tokio clock proves
    // there is no polling or wall-clock sleep in this ownership transition.
    let heartbeat_period = Duration::from_millis(session::policy::SessionPolicy::HEARTBEAT_TICK_MS);
    let mut heartbeat_timer = tokio::time::interval_at(
        tokio::time::Instant::now() + heartbeat_period,
        heartbeat_period,
    );
    tokio::time::advance(heartbeat_period).await;
    heartbeat_timer.tick().await;

    let active_evictions = heartbeat_tick(
        &mut registry.peers,
        &mut registry.wt_upgrade_pending,
        &mut registry.parked,
        &None,
        &network_state,
        &event_tx,
        &mut rebind_telemetry,
        &[],
        start_instant,
    )
    .await;
    assert!(active_evictions.is_empty());
    let expired = registry.parked.take_removed_peer_ids();
    assert_eq!(expired, [Arc::from(PEER_ID)]);

    // Seeded here, after the heartbeat tick, deliberately. `heartbeat_tick`
    // also prunes `wt_upgrade_pending` by its own TTL, and this test runs on
    // a `start_instant` far enough in the past that any entry seeded earlier
    // is swept by that TTL instead — which would make every assertion below
    // pass without retirement doing anything at all.
    let live_upgrade_ms = now_ms_since(start_instant);
    registry
        .wt_temp_to_real
        .insert("wt-temp-expired".to_string(), Arc::from(PEER_ID));
    registry.wt_upgrade_pending.insert(
        "wt-temp-expired".to_string(),
        WtUpgradePending {
            browser_node_id: PEER_ID.to_string(),
            nonce_hex: "expired-nonce".to_string(),
            issued_at_ms: live_upgrade_ms,
            proof_arrival: None,
        },
    );
    // A second identity's ownership, as a negative control: retirement must
    // be scoped to the expired peer, not a blanket clear.
    registry
        .wt_temp_to_real
        .insert("wt-temp-survivor".to_string(), Arc::from("other-browser"));
    registry.wt_upgrade_pending.insert(
        "wt-temp-survivor".to_string(),
        WtUpgradePending {
            browser_node_id: "other-browser".to_string(),
            nonce_hex: "survivor-nonce".to_string(),
            issued_at_ms: live_upgrade_ms,
            proof_arrival: None,
        },
    );

    retire_peer_transport_ownership(expired, &mut registry, &network_state, &wt_state).await;

    assert!(!registry.edge_dials.contains_key(PEER_ID));
    assert!(
        !registry.wt_temp_to_real.contains_key("wt-temp-expired"),
        "retirement must drop the expired identity's direct-WT id mapping"
    );
    assert!(
        !registry.wt_upgrade_pending.contains_key("wt-temp-expired"),
        "retirement must drop the expired identity's in-flight direct-WT upgrade"
    );
    assert_eq!(
        registry
            .wt_temp_to_real
            .get("wt-temp-survivor")
            .map(|id| &**id),
        Some("other-browser"),
        "retiring one identity must not disturb another's direct-WT ownership"
    );
    assert!(registry.wt_upgrade_pending.contains_key("wt-temp-survivor"));
    let state = network_state.read().await;
    assert!(!state.edge_interactive.contains_key(PEER_ID));
    assert!(!state.edge_bulk.contains_key(PEER_ID));
    drop(state);

    let mut next_generation = 2;
    let action = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: PEER_ID.to_string(),
            session_id: SESSION_ID.to_string(),
            generation: 1,
            lane: EdgeLane::Interactive,
            tunnel: interactive,
            close_reason: edge_tunnel::EdgeTunnelCloseReason::Other,
        },
        &mut registry.edge_dials,
        &mut next_generation,
        &mut registry.peers,
        &network_state,
        true,
        0.0,
    )
    .await;
    assert!(
        action.is_none(),
        "late lane-close events cannot restart an expired parked identity"
    );
}

#[test]
fn repeated_session_start_retries_only_failed_lanes() {
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let config = test_edge_config();
    let first = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-1",
        &test_pending_session_request("session-1", 1),
        &config,
        &mut next_generation,
    );
    let interactive = first.interactive.expect("interactive generation");
    let first_bulk = first.bulk.expect("bulk generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", interactive, EdgeLane::Interactive),
        true,
    ));
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", first_bulk, EdgeLane::Bulk),
        false,
    ));

    let retry = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-1",
        &test_pending_session_request("session-1", 1),
        &config,
        &mut next_generation,
    );
    assert_eq!(retry.interactive, None);
    let retry_bulk = retry.bulk.expect("failed bulk lane retries");
    assert_ne!(retry_bulk, first_bulk);
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", retry_bulk, EdgeLane::Bulk),
        true,
    ));

    assert_eq!(
        begin_edge_dial(
            &mut dials,
            "browser-1",
            "session-1",
            &test_pending_session_request("session-1", 1),
            &config,
            &mut next_generation,
        ),
        EdgeDialPlan {
            signaling: None,
            interactive: None,
            bulk: None,
        }
    );

    let replacement = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-2",
        &test_pending_session_request("session-2", 4),
        &config,
        &mut next_generation,
    );
    assert!(replacement.interactive.is_some());
    assert!(replacement.bulk.is_some());
}

#[tokio::test]
async fn reused_session_id_cannot_replace_the_pending_pq_tuple() {
    const PEER_ID: &str = "browser-1";
    const SESSION_ID: &str = "session-1";
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let config = test_edge_config();
    let first_request = test_pending_session_request(SESSION_ID, 1);
    let first_plan = begin_edge_dial(
        &mut dials,
        PEER_ID,
        SESSION_ID,
        &first_request,
        &config,
        &mut next_generation,
    );
    let conflicting_request = test_pending_session_request(SESSION_ID, 2);
    let conflicting_plan = begin_edge_dial(
        &mut dials,
        PEER_ID,
        SESSION_ID,
        &conflicting_request,
        &config,
        &mut next_generation,
    );

    assert!(first_plan.interactive.is_some());
    assert_eq!(
        conflicting_plan,
        EdgeDialPlan {
            signaling: None,
            interactive: None,
            bulk: None
        }
    );
    let pending = &dials[PEER_ID].pending_request;
    assert_eq!(pending.user_id(), "user-1");
    assert!(pending.matches(
        SESSION_ID,
        &[1; merkur_e2e::SESSION_NONCE_BYTES],
        &[1; merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES],
    ));
    assert!(!pending.matches(
        SESSION_ID,
        &[2; merkur_e2e::SESSION_NONCE_BYTES],
        &[2; merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES],
    ));

    let (attach_tx, _attach_rx) = mpsc::channel(1);
    let (event_tx, _event_output) = test_event_sink();
    let mut cancelled = CancelledSessions::default();
    let generation_before_rejection = next_generation;
    assert!(!handle_start_session(
        &mut dials,
        &mut cancelled,
        &mut next_generation,
        &attach_tx,
        &edge_tunnel::EdgeAdmission::for_test(),
        &event_tx,
        &start_session_payload(SESSION_ID, PEER_ID),
        100.0,
    ));
    assert_eq!(next_generation, generation_before_rejection);
    assert!(dials[PEER_ID].pending_request.matches(
        SESSION_ID,
        &[1; merkur_e2e::SESSION_NONCE_BYTES],
        &[1; merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES],
    ));
}

#[tokio::test]
async fn stale_lane_close_cannot_detach_the_current_generation() {
    let config = test_edge_config();
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-1",
        &test_pending_session_request("session-1", 1),
        &config,
        &mut next_generation,
    );
    let current_generation = plan.interactive.expect("interactive generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", current_generation, EdgeLane::Interactive),
        true,
    ));
    let (current, _current_rx) = capture_tunnel();
    let (stale, _stale_rx) = capture_tunnel();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    network_state
        .write()
        .await
        .edge_interactive
        .insert("browser-1".to_string(), current.clone());
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    peer.edge_tunnel = Some(current.clone());
    let mut peers = PeerMap::from([("browser-1".into(), peer)]);

    let redial = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: "browser-1".to_string(),
            session_id: "session-1".to_string(),
            generation: current_generation.wrapping_add(99),
            lane: EdgeLane::Interactive,
            tunnel: stale,
            close_reason: edge_tunnel::EdgeTunnelCloseReason::CounterpartDetached,
        },
        &mut dials,
        &mut next_generation,
        &mut peers,
        &network_state,
        true,
        0.0,
    )
    .await;

    assert!(redial.is_none());
    assert!(!redial.park_peer);
    assert!(
        network_state
            .read()
            .await
            .edge_interactive
            .get("browser-1")
            .is_some_and(|registered| Arc::ptr_eq(registered, &current))
    );
    assert!(
        peers["browser-1"]
            .edge_tunnel
            .as_ref()
            .is_some_and(|registered| Arc::ptr_eq(registered, &current))
    );
    assert_eq!(
        dials["browser-1"].interactive,
        EdgeDialLane {
            generation: current_generation,
            state: EdgeDialLaneState::Succeeded,
        }
    );
}

#[tokio::test]
async fn current_interactive_close_detaches_conn1_and_schedules_one_immediate_redial() {
    use connection::{SentDatagram, SentPaths, SentRow, SentRows};
    use merkur_codec::CellRepr;

    let config = test_edge_config();
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-1",
        &test_pending_session_request("session-1", 1),
        &config,
        &mut next_generation,
    );
    let generation = plan.interactive.expect("interactive generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", generation, EdgeLane::Interactive),
        true,
    ));
    let (tunnel, _capture_rx) = capture_tunnel();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    network_state
        .write()
        .await
        .edge_interactive
        .insert("browser-1".to_string(), tunnel.clone());
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.generation = 7;
    peer.last_display_seq_sent = 13;
    peer.display_cache.resize(1, 3);
    peer.display_cache.initialized = true;
    peer.edge_tunnel = Some(tunnel.clone());

    let edge_row = SentRow {
        graphics: None,
        row: 0,
        hash: 101,
        cells: vec![CellRepr::BLANK].into(),
    };
    let edge_paths = SentPaths::single(PeerTransport::Edge);
    peer.display_cache.record_sent_rows_on_paths(
        10,
        std::slice::from_ref(&edge_row),
        10.0,
        edge_paths,
        25.0,
    );
    peer.display_cache.insert_sent_datagram(
        10,
        SentDatagram {
            sent_at_ms: 10.0,
            rows: SentRows::from_iter([edge_row]),
            sent_via: edge_paths,
            header_only: false,
            reliable: false,
            protection: connection::DisplayDatagramProtection::Unprotected,
        },
    );

    let direct_row = SentRow {
        graphics: None,
        row: 1,
        hash: 202,
        cells: vec![CellRepr::BLANK].into(),
    };
    let direct_paths = SentPaths::single(PeerTransport::WebTransport);
    peer.display_cache.record_sent_rows_on_paths(
        11,
        std::slice::from_ref(&direct_row),
        11.0,
        direct_paths,
        25.0,
    );
    peer.display_cache.insert_sent_datagram(
        11,
        SentDatagram {
            sent_at_ms: 11.0,
            rows: SentRows::from_iter([direct_row]),
            sent_via: direct_paths,
            header_only: false,
            reliable: false,
            protection: connection::DisplayDatagramProtection::Unprotected,
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
            protection: connection::DisplayDatagramProtection::Unprotected,
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
            protection: connection::DisplayDatagramProtection::Unprotected,
        },
    );
    for path in [PeerTransport::WebTransport, PeerTransport::Edge] {
        peer.display_cache.fec_evidence.get_mut(path).observe(
            connection::DisplayDatagramProtection::Unprotected,
            connection::DisplayDatagramOutcome::Lost,
        );
    }
    let mut peers = PeerMap::from([("browser-1".into(), peer)]);
    let closed = || EdgeLaneClosed {
        peer_id: "browser-1".to_string(),
        session_id: "session-1".to_string(),
        generation,
        lane: EdgeLane::Interactive,
        tunnel: tunnel.clone(),
        close_reason: edge_tunnel::EdgeTunnelCloseReason::Other,
    };

    let action = handle_edge_lane_closed(
        closed(),
        &mut dials,
        &mut next_generation,
        &mut peers,
        &network_state,
        true,
        0.0,
    )
    .await;
    assert!(
        !action.park_peer,
        "ordinary transport close is not a detach proof"
    );
    let redial = action.expect("current conn1 schedules a redial");
    assert_eq!(redial.lane, EdgeLane::Interactive);
    assert_eq!(redial.session_id, "session-1");
    assert_eq!(redial.config.url, config.url);
    assert_ne!(redial.generation, generation);
    assert!(
        !network_state
            .read()
            .await
            .edge_interactive
            .contains_key("browser-1")
    );
    assert!(peers["browser-1"].edge_tunnel.is_none());
    let peer = peers.get_mut("browser-1").expect("live direct peer");
    assert_eq!(peer.display_cache.sent_row_latest_seq, vec![0, 11, 12]);
    assert!(peer.display_cache.sent_row_force_full_until_confirmed[0]);
    assert!(!peer.display_cache.sent_datagrams.contains_key(&10));
    assert!(peer.display_cache.sent_datagrams.contains_key(&11));
    assert!(peer.display_cache.sent_datagrams.contains_key(&12));
    assert!(peer.display_cache.sent_datagrams.contains_key(&13));
    assert_eq!(
        peer.display_cache.sent_datagrams[&12].outcome_path(),
        None,
        "the surviving dual send remains unattributable"
    );
    assert_eq!(
        peer.display_cache
            .datagram_outcomes
            .get(PeerTransport::Edge)
            .outcome_unknown,
        1,
        "the edge-only send becomes unknown exactly once"
    );
    assert!(
        !peer
            .display_cache
            .fec_evidence
            .get(PeerTransport::Edge)
            .replication_enabled()
    );
    assert!(
        peer.display_cache
            .fec_evidence
            .get(PeerTransport::WebTransport)
            .replication_enabled()
    );

    // Sequence 10 sits three packets below the applied header at 13. If the
    // retired edge-only record survived, this ACK would classify it Lost and
    // immediately re-promote the freshly reset edge replication controller.
    display::recv::handle_display_ack(
        peer,
        display::recv::DisplayAck::new(7, 13, [1, 0, 0, 0]),
        20.0,
        PeerTransport::Edge,
        &[101, 202, 303],
        false,
    );
    assert!(
        !peer
            .display_cache
            .fec_evidence
            .get(PeerTransport::Edge)
            .replication_enabled(),
        "a late ACK from the retired edge cannot enter fresh FEC evidence"
    );
    assert_eq!(
        peer.display_cache
            .datagram_outcomes
            .get(PeerTransport::Edge)
            .declared_lost,
        0
    );
    assert!(peer.display_cache.sent_datagrams.contains_key(&11));
    assert!(peer.display_cache.sent_datagrams.contains_key(&12));

    let generation_after_first = next_generation;
    assert!(
        handle_edge_lane_closed(
            closed(),
            &mut dials,
            &mut next_generation,
            &mut peers,
            &network_state,
            true,
            0.0,
        )
        .await
        .is_none()
    );
    assert_eq!(
        next_generation, generation_after_first,
        "a duplicate close must not allocate or spawn another dial"
    );
}

/// Losing our OWN tunnel is a carrier gap, not the end of the session.
///
/// Before this, the gap window could only ever be armed from the edge's
/// `CounterpartDetached` — which needs a tunnel we have just taken — and
/// `reconcile_rebind_windows` cleared any window the moment the tunnel was
/// gone. So the liveness sweep's park guard was unreachable on exactly the
/// path it exists for, and a daemon-side carrier loss destroyed the Noise
/// session and the rebind lineage for a gap the redial was about to close.
#[tokio::test]
async fn losing_our_own_tunnel_arms_the_gap_window_instead_of_stranding_the_peer() {
    let config = test_edge_config();
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-1",
        &test_pending_session_request("session-1", 1),
        &config,
        &mut next_generation,
    );
    let generation = plan.interactive.expect("interactive generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", generation, EdgeLane::Interactive),
        true,
    ));
    let (tunnel, _capture_rx) = capture_tunnel();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    network_state
        .write()
        .await
        .edge_interactive
        .insert("browser-1".to_string(), tunnel.clone());
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.display_cache.resize(2, 1);
    peer.display_cache.initialized = true;
    peer.edge_tunnel = Some(tunnel.clone());
    let mut peers = PeerMap::from([("browser-1".into(), peer)]);

    let now_ms = 1_000.0;
    let action = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: "browser-1".to_string(),
            session_id: "session-1".to_string(),
            generation,
            lane: EdgeLane::Interactive,
            tunnel: tunnel.clone(),
            close_reason: edge_tunnel::EdgeTunnelCloseReason::Other,
        },
        &mut dials,
        &mut next_generation,
        &mut peers,
        &network_state,
        true,
        now_ms,
    )
    .await;
    assert!(!action.park_peer, "a transport close is not a detach proof");

    let window = peers["browser-1"]
        .edge_rebind
        .expect("losing our own tunnel must arm the gap window");
    assert_eq!(
        window.deadline_ms,
        now_ms + crate::session::policy::SessionPolicy::REBIND_WINDOW_MS as f64
            - crate::session::policy::SessionPolicy::HEARTBEAT_TICK_MS as f64,
        "the window must land one tick inside the edge's own half-paired expiry"
    );
    assert_eq!(window.rebinds_used, 0);

    // The window is what the sweep's park guard reads, and reconciliation
    // must not take it away just because the tunnel it was armed for is the
    // one that died.
    crate::session::liveness::reconcile_rebind_windows_for_test(&mut peers, now_ms + 1.0);
    assert!(
        peers["browser-1"].edge_rebind.is_some(),
        "a window armed by our own tunnel loss survives reconciliation"
    );
}

/// A failed redial keeps trying while the carrier gap is armed.
///
/// One autonomous permit per lifecycle event was a deadlock, not a storm
/// guard. The lane close spends it to schedule a dial; when that dial fails
/// — the ordinary case, because the network that killed the tunnel is
/// usually still down a few hundred milliseconds later — nothing rearms it.
/// `network_change` rides the carrier that is gone and a successful attach
/// never replenishes, so only a server-dispatched `session_start` could
/// revive the lane. The daemon knew its lane was dead, had a browser waiting
/// at the edge, and could not dial: reconnecting by hand was the only exit,
/// which is exactly the reported symptom.
///
/// The ladder now terminates on the carrier-gap deadline instead, which is
/// the only thing that makes the session worth dialling for.
#[tokio::test]
async fn a_failed_redial_keeps_trying_while_the_carrier_gap_is_armed() {
    let config = test_edge_config();
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-1",
        &test_pending_session_request("session-1", 1),
        &config,
        &mut next_generation,
    );
    let first = plan.interactive.expect("interactive generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", first, EdgeLane::Interactive),
        true,
    ));

    let (tunnel, _capture_rx) = capture_tunnel();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    // The lane must be the one the registry currently owns, or the close is
    // read as an intentional teardown and autonomous redial is suppressed.
    network_state
        .write()
        .await
        .edge_interactive
        .insert("browser-1".to_string(), tunnel.clone());
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.display_cache.resize(2, 1);
    peer.display_cache.initialized = true;
    peer.edge_tunnel = Some(tunnel.clone());
    let mut peers = PeerMap::from([("browser-1".into(), peer)]);

    let now_ms = 1_000.0;
    let action = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: "browser-1".to_string(),
            session_id: "session-1".to_string(),
            generation: first,
            lane: EdgeLane::Interactive,
            tunnel: tunnel.clone(),
            close_reason: edge_tunnel::EdgeTunnelCloseReason::Other,
        },
        &mut dials,
        &mut next_generation,
        &mut peers,
        &network_state,
        true,
        now_ms,
    )
    .await;
    let redial = action
        .redial
        .expect("the lane close must schedule one dial");
    let window = peers["browser-1"].edge_rebind.expect("gap window armed");

    // That dial fails, which is what spends the last permit.
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", redial.generation, EdgeLane::Interactive),
        false,
    ));
    assert!(
        restart_failed_edge_lane(
            &mut dials,
            "browser-1",
            "session-1",
            EdgeLane::Interactive,
            &mut next_generation,
            false,
        )
        .is_none(),
        "the permit must be spent here — if it is not, this test is not \
         exercising the deadlock it exists for"
    );

    let due_at_ms =
        schedule_background_edge_redial(&mut dials, &peers, "browser-1", "session-1", now_ms)
            .expect("a failed dial inside an armed gap must schedule another");
    assert!(
        due_at_ms > now_ms && due_at_ms <= window.deadline_ms,
        "the next attempt must be in the future and never past the deadline \
         that terminates the ladder"
    );
    assert!(
        take_due_edge_redials(&mut dials, &peers, now_ms, &mut next_generation).is_empty(),
        "a scheduled attempt must not fire before it is due"
    );

    let due = take_due_edge_redials(&mut dials, &peers, due_at_ms, &mut next_generation);
    assert_eq!(due.len(), 1, "the due attempt was not taken");
    assert_eq!(due[0].peer_id, "browser-1");
    assert_eq!(due[0].lane, EdgeLane::Interactive);

    // And the window is the terminating condition: once it lapses there is
    // no lineage left to repair and the ladder stops on its own.
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", due[0].generation, EdgeLane::Interactive),
        false,
    ));
    assert!(
        schedule_background_edge_redial(
            &mut dials,
            &peers,
            "browser-1",
            "session-1",
            window.deadline_ms + 1.0,
        )
        .is_none(),
        "the ladder must stop once the carrier gap has expired"
    );
}

#[tokio::test]
async fn generic_edge_close_has_one_fallback_then_waits_for_a_concrete_event() {
    const PEER_ID: &str = "browser-1";
    const SESSION_ID: &str = "storm-session";
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let first = begin_edge_dial(
        &mut dials,
        PEER_ID,
        SESSION_ID,
        &test_pending_session_request(SESSION_ID, 1),
        &test_edge_config(),
        &mut next_generation,
    );
    let first_generation = first.interactive.expect("initial generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for(SESSION_ID, first_generation, EdgeLane::Interactive),
        true,
    ));

    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    let (first_tunnel, _first_rx) = capture_tunnel();
    network_state
        .write()
        .await
        .edge_interactive
        .insert(PEER_ID.to_string(), first_tunnel.clone());
    let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::WebTransport);
    peer.edge_tunnel = Some(first_tunnel.clone());
    let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);

    let first_action = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: PEER_ID.to_string(),
            session_id: SESSION_ID.to_string(),
            generation: first_generation,
            lane: EdgeLane::Interactive,
            tunnel: first_tunnel,
            close_reason: edge_tunnel::EdgeTunnelCloseReason::Other,
        },
        &mut dials,
        &mut next_generation,
        &mut peers,
        &network_state,
        true,
        0.0,
    )
    .await;
    let fallback = first_action.expect("first close consumes the fallback");
    assert!(!dials[PEER_ID].lifecycle.interactive_redial_available);

    assert!(accept_edge_attach(
        &mut dials,
        &attach_for(SESSION_ID, fallback.generation, EdgeLane::Interactive),
        true,
    ));
    let (fallback_tunnel, _fallback_rx) = capture_tunnel();
    network_state
        .write()
        .await
        .edge_interactive
        .insert(PEER_ID.to_string(), fallback_tunnel.clone());
    peers.get_mut(PEER_ID).unwrap().edge_tunnel = Some(fallback_tunnel.clone());

    let second_action = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: PEER_ID.to_string(),
            session_id: SESSION_ID.to_string(),
            generation: fallback.generation,
            lane: EdgeLane::Interactive,
            tunnel: fallback_tunnel,
            close_reason: edge_tunnel::EdgeTunnelCloseReason::Other,
        },
        &mut dials,
        &mut next_generation,
        &mut peers,
        &network_state,
        true,
        0.0,
    )
    .await;
    assert!(
        second_action.redial.is_none(),
        "a successful socket attach does not replenish fallback ownership"
    );
    assert_eq!(dials[PEER_ID].interactive.state, EdgeDialLaneState::Failed);

    let concrete = begin_edge_dial(
        &mut dials,
        PEER_ID,
        SESSION_ID,
        &test_pending_session_request(SESSION_ID, 1),
        &test_edge_config(),
        &mut next_generation,
    );
    assert!(
        concrete.interactive.is_some(),
        "session_start is the event that re-arms and retries the failed lane"
    );
    assert!(dials[PEER_ID].lifecycle.interactive_redial_available);
}

#[tokio::test]
async fn typed_detach_without_initialized_resume_state_retires_immediately() {
    const PEER_ID: &str = "browser-1";
    const SESSION_ID: &str = "uninitialized-session";
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_edge_dial(
        &mut dials,
        PEER_ID,
        SESSION_ID,
        &test_pending_session_request(SESSION_ID, 1),
        &test_edge_config(),
        &mut next_generation,
    );
    let generation = plan.interactive.expect("interactive generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for(SESSION_ID, generation, EdgeLane::Interactive),
        true,
    ));
    let (tunnel, _capture_rx) = capture_tunnel();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    network_state
        .write()
        .await
        .edge_interactive
        .insert(PEER_ID.to_string(), tunnel.clone());
    let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.edge_tunnel = Some(tunnel.clone());
    let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);

    let mut action = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: PEER_ID.to_string(),
            session_id: SESSION_ID.to_string(),
            generation,
            lane: EdgeLane::Interactive,
            tunnel,
            close_reason: edge_tunnel::EdgeTunnelCloseReason::CounterpartDetached,
        },
        &mut dials,
        &mut next_generation,
        &mut peers,
        &network_state,
        true,
        0.0,
    )
    .await;
    assert!(action.redial.is_none());
    let retired = action
        .retired_unresumable
        .take()
        .expect("uninitialized detach retires the exact dial owner");
    assert!(!dials.contains_key(PEER_ID));

    let mut parked = ParkedPeers::new();
    let (event_tx, _event_output) = test_event_sink();
    park_edge_counterpart_detached_peer(
        PEER_ID,
        &mut peers,
        &mut parked,
        &event_tx,
        Instant::now(),
    );
    retire_edge_preauth_ownership(vec![retired], &mut peers, &network_state).await;

    assert!(!peers.contains_key(PEER_ID));
    assert_eq!(parked.len(), 0, "uninitialized state is not resumable");
    assert!(
        !network_state
            .read()
            .await
            .edge_interactive
            .contains_key(PEER_ID)
    );
}

#[tokio::test]
async fn typed_current_interactive_detach_parks_only_without_an_alternate_path() {
    let config = test_edge_config();
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-1",
        &test_pending_session_request("session-1", 1),
        &config,
        &mut next_generation,
    );
    let generation = plan.interactive.expect("interactive generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", generation, EdgeLane::Interactive),
        true,
    ));
    let (tunnel, _capture_rx) = capture_tunnel();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    network_state
        .write()
        .await
        .edge_interactive
        .insert("browser-1".to_string(), tunnel.clone());
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.display_cache.resize(2, 1);
    peer.display_cache.initialized = true;
    peer.edge_tunnel = Some(tunnel.clone());
    let mut peers = PeerMap::from([("browser-1".into(), peer)]);

    let action = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: "browser-1".to_string(),
            session_id: "session-1".to_string(),
            generation,
            lane: EdgeLane::Interactive,
            tunnel,
            close_reason: edge_tunnel::EdgeTunnelCloseReason::CounterpartDetached,
        },
        &mut dials,
        &mut next_generation,
        &mut peers,
        &network_state,
        true,
        0.0,
    )
    .await;

    assert!(action.park_peer, "exact current edge ownership is required");
    assert!(
        action.redial.is_some(),
        "reconnect keeps a fresh daemon half"
    );
    assert!(
        action.retired_unresumable.is_none(),
        "authenticated initialized state remains governed by parked resume"
    );
    assert!(should_park_after_edge_detach(
        &action,
        AlternateTransportOwnership::default()
    ));
    assert!(!should_park_after_edge_detach(
        &action,
        AlternateTransportOwnership {
            direct_webtransport: true,
        }
    ));
}

#[tokio::test]
async fn current_bulk_close_detaches_conn2_and_revokes_its_handshake() {
    let config = test_edge_config();
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-1",
        &test_pending_session_request("session-1", 1),
        &config,
        &mut next_generation,
    );
    let generation = plan.bulk.expect("bulk generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", generation, EdgeLane::Bulk),
        true,
    ));
    let (tunnel, _capture_rx) = capture_tunnel();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    network_state
        .write()
        .await
        .edge_bulk
        .insert("browser-1".to_string(), tunnel.clone());
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
    peer.edge_tunnel_bulk = Some(tunnel.clone());
    peer.bulk_delivery_confirmed = true;
    let mut peers = PeerMap::from([("browser-1".into(), peer)]);

    let redial = handle_edge_lane_closed(
        EdgeLaneClosed {
            peer_id: "browser-1".to_string(),
            session_id: "session-1".to_string(),
            generation,
            lane: EdgeLane::Bulk,
            tunnel,
            close_reason: edge_tunnel::EdgeTunnelCloseReason::CounterpartDetached,
        },
        &mut dials,
        &mut next_generation,
        &mut peers,
        &network_state,
        true,
        0.0,
    )
    .await;
    assert!(!redial.park_peer, "bulk ownership never retires the peer");
    let redial = redial.expect("current conn2 schedules a redial");

    assert_eq!(redial.lane, EdgeLane::Bulk);
    assert!(
        !network_state
            .read()
            .await
            .edge_bulk
            .contains_key("browser-1")
    );
    assert!(peers["browser-1"].edge_tunnel_bulk.is_none());
    assert!(!peers["browser-1"].bulk_delivery_confirmed);
}

#[tokio::test]
async fn teardown_and_shutdown_suppress_lane_resurrection() {
    let config = test_edge_config();
    let mut dials = HashMap::new();
    let mut next_generation = 0;
    let plan = begin_edge_dial(
        &mut dials,
        "browser-1",
        "session-1",
        &test_pending_session_request("session-1", 1),
        &config,
        &mut next_generation,
    );
    let generation = plan.interactive.expect("interactive generation");
    assert!(accept_edge_attach(
        &mut dials,
        &attach_for("session-1", generation, EdgeLane::Interactive),
        true,
    ));
    let (tunnel, _capture_rx) = capture_tunnel();
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    network_state
        .write()
        .await
        .edge_interactive
        .insert("browser-1".to_string(), tunnel.clone());
    let mut peers = HashMap::new();

    // Shutdown still detaches the current lane but never allocates a new
    // generation or dial request.
    let generation_before_shutdown = next_generation;
    assert!(
        handle_edge_lane_closed(
            EdgeLaneClosed {
                peer_id: "browser-1".to_string(),
                session_id: "session-1".to_string(),
                generation,
                lane: EdgeLane::Interactive,
                tunnel: tunnel.clone(),
                close_reason: edge_tunnel::EdgeTunnelCloseReason::Other,
            },
            &mut dials,
            &mut next_generation,
            &mut peers,
            &network_state,
            false,
            0.0,
        )
        .await
        .is_none()
    );
    assert_eq!(next_generation, generation_before_shutdown);
    assert_eq!(
        dials["browser-1"].interactive.state,
        EdgeDialLaneState::Failed
    );

    // Intentional peer teardown removes lifecycle ownership before the
    // bridge event arrives; that stale event cannot recreate the session.
    dials.remove("browser-1");
    assert!(
        handle_edge_lane_closed(
            EdgeLaneClosed {
                peer_id: "browser-1".to_string(),
                session_id: "session-1".to_string(),
                generation,
                lane: EdgeLane::Interactive,
                tunnel,
                close_reason: edge_tunnel::EdgeTunnelCloseReason::Other,
            },
            &mut dials,
            &mut next_generation,
            &mut peers,
            &network_state,
            true,
            0.0,
        )
        .await
        .is_none()
    );
    assert!(!dials.contains_key("browser-1"));
}
