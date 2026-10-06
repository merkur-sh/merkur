use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

use connection::{
    DisplayDatagramOutcome, DisplayDatagramProtection, SentDatagram, SentPaths, SentRow, SentRows,
};
use merkur_codec::CellRepr;

struct DropProbe(Arc<AtomicUsize>);

impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn seed_display_attempts_across_both_paths(peer: &mut PeerDisplayState) {
    peer.paths.edge.available = true;
    peer.needs_full_diff = false;
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
            protection: DisplayDatagramProtection::Unprotected,
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
            protection: DisplayDatagramProtection::Unprotected,
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
            protection: DisplayDatagramProtection::Unprotected,
        },
    );
    peer.display_cache.insert_sent_datagram(
        13,
        SentDatagram {
            sent_at_ms: 13.0,
            rows: SentRows::default(),
            sent_via: SentPaths::single(PeerTransport::WebTransport),
            header_only: true,
            reliable: false,
            protection: DisplayDatagramProtection::Unprotected,
        },
    );

    for path in [PeerTransport::WebTransport, PeerTransport::Edge] {
        peer.display_cache.fec_evidence.get_mut(path).observe(
            DisplayDatagramProtection::Unprotected,
            DisplayDatagramOutcome::Lost,
        );
    }
}

fn assert_only_replaced_direct_work_was_retired(peer: &PeerDisplayState) {
    assert!(!peer.paths.webtransport.available);
    assert!(peer.paths.edge.available);
    assert!(peer.needs_full_diff);
    assert_eq!(peer.display_cache.sent_row_latest_seq, vec![0, 11, 12]);
    assert!(!peer.display_cache.sent_datagrams.contains_key(&10));
    assert!(peer.display_cache.sent_datagrams.contains_key(&11));
    assert!(peer.display_cache.sent_datagrams.contains_key(&12));
    assert!(!peer.display_cache.sent_datagrams.contains_key(&13));
    assert!(!peer.display_cache.sent_row_has_reliable_attempt[0]);
    assert!(peer.display_cache.sent_row_force_full_until_confirmed[0]);
    assert!(
        !peer
            .display_cache
            .fec_evidence
            .get(PeerTransport::WebTransport)
            .replication_enabled()
    );
    assert!(
        peer.display_cache
            .fec_evidence
            .get(PeerTransport::Edge)
            .replication_enabled()
    );
    assert_eq!(
        peer.display_cache
            .datagram_outcomes
            .webtransport
            .outcome_unknown,
        1
    );
    assert_eq!(peer.display_cache.datagram_outcomes.edge.outcome_unknown, 0);
}

#[test]
fn maintenance_is_single_flight_and_reprobe_has_one_trailing_edge() {
    let mut owner = WtMaintenanceOwner::default();
    owner.request(WtMaintenanceKind::Startup);
    owner.request(WtMaintenanceKind::Startup);
    let startup = owner.begin_next().expect("startup begins");
    assert_eq!(startup.kind, WtMaintenanceKind::Startup);
    assert!(
        owner.begin_next().is_none(),
        "only one operation is in flight"
    );

    owner.request(WtMaintenanceKind::Startup);
    assert!(
        owner
            .accept(WtMaintenanceCompletion {
                generation: startup.generation,
                kind: startup.kind,
                result: (),
            })
            .is_some()
    );
    assert!(
        owner.begin_next().is_none(),
        "duplicate startup does not restart a healthy server"
    );

    owner.request(WtMaintenanceKind::Reprobe);
    let first_reprobe = owner.begin_next().expect("reprobe begins");
    owner.request(WtMaintenanceKind::Reprobe);
    owner.request(WtMaintenanceKind::Reprobe);
    assert!(
        owner
            .accept(WtMaintenanceCompletion {
                generation: first_reprobe.generation,
                kind: first_reprobe.kind,
                result: (),
            })
            .is_some()
    );
    let trailing = owner.begin_next().expect("one trailing reprobe");
    assert_eq!(trailing.kind, WtMaintenanceKind::Reprobe);
    assert_ne!(trailing.generation, first_reprobe.generation);
    assert!(owner.begin_next().is_none());
    assert!(
        owner
            .accept(WtMaintenanceCompletion {
                generation: trailing.generation,
                kind: trailing.kind,
                result: (),
            })
            .is_some()
    );
    assert!(owner.begin_next().is_none(), "burst coalesced to one edge");
}

/// The daemon answers IPv6 reachability exactly once, inside `start_server`,
/// and `start_server` runs only for `Startup`. So a `configure` that lands
/// before the first STUN credential must hand its start to that credential
/// rather than spending the probe unauthenticated — production spent it that
/// way on every boot, logging `no STUN credential yet` and then
/// `ipv6_reachability="unknown"` ~205 ms before the credential arrived.
#[test]
fn a_listener_held_for_the_first_credential_starts_instead_of_reprobing() {
    assert_eq!(
        wt_maintenance_for_first_credential(true),
        WtMaintenanceKind::Startup,
        "a held listener has never bound the port, so the probe can still run"
    );

    let mut owner = WtMaintenanceOwner::default();
    owner.request(wt_maintenance_for_first_credential(true));
    let started = owner
        .begin_next()
        .expect("the credential starts the listener");
    assert_eq!(started.kind, WtMaintenanceKind::Startup);
}

/// The other half: under a live server the port is quinn's, so re-running
/// `start_server` would be `EADDRINUSE`. Recovering the reflexive candidate
/// is all that is on offer, and it must stay that way.
#[test]
fn a_credential_regained_under_a_live_server_only_reprobes() {
    assert_eq!(
        wt_maintenance_for_first_credential(false),
        WtMaintenanceKind::Reprobe,
    );
}

#[test]
fn rotation_has_priority_over_a_queued_topology_refresh() {
    let mut owner = WtMaintenanceOwner::default();
    owner.request(WtMaintenanceKind::Reprobe);
    owner.request(WtMaintenanceKind::Rotation);

    let rotation = owner.begin_next().expect("rotation first");
    assert_eq!(rotation.kind, WtMaintenanceKind::Rotation);
    owner
        .accept(WtMaintenanceCompletion {
            generation: rotation.generation,
            kind: rotation.kind,
            result: (),
        })
        .unwrap();
    let reprobe = owner.begin_next().expect("reprobe second");
    assert_eq!(reprobe.kind, WtMaintenanceKind::Reprobe);
    owner
        .accept(WtMaintenanceCompletion {
            generation: reprobe.generation,
            kind: reprobe.kind,
            result: (),
        })
        .unwrap();
    assert!(owner.begin_next().is_none());
}

#[test]
fn external_network_edge_preserves_one_startup_recovery_generation() {
    let mut owner = WtMaintenanceOwner::default();
    owner.request(WtMaintenanceKind::Startup);
    let first = owner.begin_next().unwrap();

    request_wt_network_change_maintenance(&mut owner, false);
    request_wt_network_change_maintenance(&mut owner, false);
    owner
        .accept(WtMaintenanceCompletion {
            generation: first.generation,
            kind: first.kind,
            result: (),
        })
        .unwrap();

    let recovery = owner.begin_next().expect("one event-driven recovery");
    assert_eq!(recovery.kind, WtMaintenanceKind::Startup);
    owner
        .accept(WtMaintenanceCompletion {
            generation: recovery.generation,
            kind: recovery.kind,
            result: (),
        })
        .unwrap();
    assert!(owner.begin_next().is_none(), "recovery burst stays bounded");

    request_wt_network_change_maintenance(&mut owner, true);
    assert_eq!(
        owner.begin_next().unwrap().kind,
        WtMaintenanceKind::Reprobe,
        "a live server refreshes candidates instead of restarting"
    );
}

#[test]
fn cancelled_generation_drops_stale_owned_result() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let mut owner = WtMaintenanceOwner::default();
    owner.request(WtMaintenanceKind::Rotation);
    let request = owner.begin_next().unwrap();
    owner.cancel_pending();

    assert!(
        owner
            .accept(WtMaintenanceCompletion {
                generation: request.generation,
                kind: request.kind,
                result: DropProbe(dropped.clone()),
            })
            .is_none()
    );
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[test]
fn eviction_resolves_real_and_temporary_webtransport_ids() {
    let mut ownership = HashMap::from([
        ("wt-pending-2".to_string(), Arc::from("browser-a")),
        ("wt-pending-1".to_string(), Arc::from("browser-a")),
        ("wt-pending-3".to_string(), Arc::from("browser-b")),
    ]);

    assert_eq!(
        take_wt_ownership_ids("browser-a", &mut ownership),
        vec![
            "browser-a".to_string(),
            "wt-pending-1".to_string(),
            "wt-pending-2".to_string(),
        ]
    );
    assert_eq!(
        ownership,
        HashMap::from([("wt-pending-3".to_string(), Arc::from("browser-b"))])
    );
}

#[tokio::test]
async fn network_change_requires_authenticated_matching_identity() {
    let mut peer = PeerDisplayState::new("browser-a".into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.paths.webtransport.last_heartbeat_sent_ms = 42.0;
    peer.paths.webtransport.last_ack_at_ms = 22.0;
    peer.paths.edge.last_heartbeat_sent_ms = 42.0;
    peer.paths.edge.last_ack_at_ms = 23.0;
    peer.paths.edge.available = false;
    peer.bulk_delivery_confirmed = true;
    let mut peers = PeerMap::from([("browser-a".into(), peer)]);
    let change = merkur_wire::signaling::NetworkChange {
        browser_node_id: "browser-a".into(),
    };

    assert!(
        !handle_network_change("browser-b", &change, &mut peers),
        "a peer cannot refresh another peer's topology"
    );
    assert!(
        handle_network_change("browser-a", &change, &mut peers),
        "matching authenticated peer produces the reprobe edge"
    );
    let peer = peers.get("browser-a").unwrap();
    assert_eq!(peer.paths.webtransport.last_heartbeat_sent_ms, 42.0);
    assert_eq!(peer.paths.webtransport.last_ack_at_ms, 22.0);
    assert_eq!(peer.paths.edge.last_heartbeat_sent_ms, 42.0);
    assert_eq!(peer.paths.edge.last_ack_at_ms, 23.0);
    assert!(!peer.paths.edge.available);
    assert!(peer.paths.webtransport.heartbeat_probe_requested);
    assert!(peer.paths.edge.heartbeat_probe_requested);
    assert!(!peer.bulk_delivery_confirmed);
}

fn wt_state_with_current_connection(
    peer_id: &str,
    connection_id: u64,
) -> Arc<RwLock<WebTransportState>> {
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

#[tokio::test]
async fn stale_a_disconnect_after_b_install_cannot_remove_or_demote_b() {
    const REAL_ID: &str = "browser-a";
    const A_ID: u64 = 11;
    const B_ID: u64 = 12;
    let state = wt_state_with_current_connection(REAL_ID, B_ID);
    let wt_state = Some(state.clone());
    let mut peer = PeerDisplayState::new(REAL_ID.into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.paths.webtransport.available = true;
    let mut registry = PeerRegistry::new();
    registry.peers.insert(REAL_ID.into(), peer);
    registry.wt_temp_to_real = HashMap::from([
        ("wt-pending-a".to_string(), Arc::from(REAL_ID)),
        ("wt-pending-b".to_string(), Arc::from(REAL_ID)),
    ]);
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    let (event_tx, _event_output) = test_event_sink();

    assert!(
        !is_current_ingress_generation(
            &wt_state,
            &registry.edge_dials,
            REAL_ID,
            PeerTransport::WebTransport,
            A_ID,
            None,
        )
        .await,
        "queued stream/datagram frames from A are rejected after B installs"
    );
    assert!(
        is_current_ingress_generation(
            &wt_state,
            &registry.edge_dials,
            REAL_ID,
            PeerTransport::WebTransport,
            B_ID,
            None,
        )
        .await,
        "B ingress remains current"
    );

    assert!(
        handle_direct_webtransport_disconnected_event(
            "wt-pending-a".to_string(),
            A_ID,
            "A closed late".to_string(),
            &mut registry,
            &wt_state,
            &network_state,
            &event_tx,
            Instant::now(),
        )
        .await,
        "stale direct-WT lifecycle event is consumed"
    );

    assert!(
        webtransport::is_current_connection(&state, REAL_ID, B_ID).await,
        "replacement B remains installed"
    );
    assert!(
        registry
            .peers
            .get(REAL_ID)
            .unwrap()
            .paths
            .webtransport
            .available,
        "stale A cannot demote B's path"
    );
    assert!(!registry.wt_temp_to_real.contains_key("wt-pending-a"));
    assert_eq!(
        registry.wt_temp_to_real.get("wt-pending-b").map(|id| &**id),
        Some(REAL_ID),
        "B retains its late-event identity mapping"
    );
}

#[tokio::test]
async fn rotation_retires_a_full_old_server_cohort_without_stale_mappings() {
    let mut retired = Vec::new();
    let mut ownership: HashMap<String, Arc<str>> = HashMap::new();
    let mut pending = HashMap::new();
    let mut peers = HashMap::new();

    for connection_id in 1..=64u64 {
        let temp_peer_id = format!("wt-pending-{connection_id}");
        let real_peer_id = format!("browser-{connection_id}");
        retired.push(webtransport::RetiredWebTransportConnection {
            temp_peer_id: temp_peer_id.clone(),
            registry_peer_id: real_peer_id.clone(),
            connection_id,
        });
        ownership.insert(temp_peer_id.clone(), Arc::from(real_peer_id.as_str()));
        pending.insert(
            temp_peer_id,
            WtUpgradePending {
                browser_node_id: real_peer_id.clone(),
                nonce_hex: "nonce".to_string(),
                issued_at_ms: 1.0,
                proof_arrival: None,
            },
        );
        let mut peer = PeerDisplayState::new(real_peer_id.into(), PeerTransport::WebTransport);
        peer.authenticated = true;
        peer.paths.webtransport.available = true;
        seed_display_attempts_across_both_paths(&mut peer);
        peers.insert(Arc::clone(&peer.peer_id), peer);
    }

    assert_eq!(
        retire_replaced_webtransport_connections(
            retired,
            &None,
            &mut ownership,
            &mut pending,
            &mut peers,
        )
        .await,
        64
    );
    assert!(ownership.is_empty());
    assert!(pending.is_empty());
    assert_eq!(peers.len(), 64);
    for peer in peers.values() {
        assert_only_replaced_direct_work_was_retired(peer);
    }
}

#[tokio::test]
async fn rotation_cleanup_cannot_demote_or_unmap_newer_b() {
    const REAL_ID: &str = "browser-a";
    const A_ID: u64 = 11;
    const B_ID: u64 = 12;
    let state = wt_state_with_current_connection(REAL_ID, B_ID);
    let wt_state = Some(state);
    let mut ownership = HashMap::from([
        ("wt-pending-11".to_string(), Arc::from(REAL_ID)),
        ("wt-pending-12".to_string(), Arc::from(REAL_ID)),
    ]);
    let mut pending = HashMap::new();
    let mut peer = PeerDisplayState::new(REAL_ID.into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.paths.webtransport.available = true;
    seed_display_attempts_across_both_paths(&mut peer);
    let mut peers = PeerMap::from([(REAL_ID.into(), peer)]);

    retire_replaced_webtransport_connections(
        vec![webtransport::RetiredWebTransportConnection {
            temp_peer_id: "wt-pending-11".to_string(),
            registry_peer_id: REAL_ID.to_string(),
            connection_id: A_ID,
        }],
        &wt_state,
        &mut ownership,
        &mut pending,
        &mut peers,
    )
    .await;

    assert!(!ownership.contains_key("wt-pending-11"));
    assert_eq!(
        ownership.get("wt-pending-12").map(|id| &**id),
        Some(REAL_ID),
        "exact A retirement must preserve B's temp ownership"
    );
    let peer = peers.get(REAL_ID).unwrap();
    assert!(
        peer.paths.webtransport.available,
        "a current B registry entry makes stale A demotion a no-op"
    );
    assert!(!peer.needs_full_diff);
    assert_eq!(peer.display_cache.sent_row_latest_seq, vec![10, 11, 12]);
    assert!(peer.display_cache.sent_datagrams.contains_key(&10));
    assert!(peer.display_cache.sent_datagrams.contains_key(&11));
    assert!(peer.display_cache.sent_datagrams.contains_key(&12));
    assert!(peer.display_cache.sent_datagrams.contains_key(&13));
    assert!(peer.display_cache.sent_row_has_reliable_attempt[0]);
    assert!(
        peer.display_cache
            .fec_evidence
            .get(PeerTransport::WebTransport)
            .replication_enabled()
    );
    assert!(
        peer.display_cache
            .fec_evidence
            .get(PeerTransport::Edge)
            .replication_enabled()
    );
    assert_eq!(
        peer.display_cache
            .datagram_outcomes
            .webtransport
            .outcome_unknown,
        0
    );
}
