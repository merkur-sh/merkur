use super::*;

#[tokio::test]
async fn linked_edge_preserves_paired_network_estimates() {
    let (capture_tx, _capture_rx) = mpsc::unbounded_channel();
    let tunnel = Arc::new(edge_tunnel::EdgeTunnel::new_capture(capture_tx));
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    network_state
        .write()
        .await
        .edge_interactive
        .insert("browser-1".to_string(), tunnel.clone());
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.authenticated = true;
    let mut browser = e2e::NoiseHandshake::new_initiator(&[1; 32], &[7; 32], b"data-link").unwrap();
    let mut daemon = e2e::NoiseHandshake::new_responder(&[2; 32], &[7; 32], b"data-link").unwrap();
    daemon
        .read_message(&browser.write_message(b"").unwrap())
        .unwrap();
    browser
        .read_message(&daemon.write_message(b"").unwrap())
        .unwrap();
    daemon
        .read_message(&browser.write_message(b"").unwrap())
        .unwrap();
    peer.noise = Some(daemon.into_transport().unwrap());
    peer.data_attachment_nonces[0] = Some([4; DATA_HANDSHAKE_NONCE_BYTES]);
    tunnel.observe_browser_hello([4; DATA_HANDSHAKE_NONCE_BYTES]);
    peer.paths.edge.network_rtt_ewma_ms = 200.0;
    peer.paths.edge.network_jitter_ewma_ms = 11.0;
    peer.paths.edge.rtt_ewma_ms = 260.0;
    peer.paths.edge.jitter_ewma_ms = 41.0;
    let mut peers = PeerMap::from([("browser-1".into(), peer)]);
    assert!(
        link_data_tunnel(
            &network_state,
            &mut peers,
            "browser-1",
            EdgeLane::Interactive,
            1_000.0
        )
        .await
    );
    let linked = &peers["browser-1"];
    assert!(Arc::ptr_eq(linked.edge_tunnel.as_ref().unwrap(), &tunnel));
    assert_eq!(linked.paths.edge.network_rtt_ewma_ms, 200.0);
    assert_eq!(linked.paths.edge.network_jitter_ewma_ms, 11.0);
    assert_eq!(linked.paths.edge.rtt_ewma_ms, 260.0);
    assert_eq!(linked.paths.edge.jitter_ewma_ms, 41.0);
    assert!(linked.paths.edge.available);
    assert_eq!(linked.paths.edge.last_ack_at_ms, 1_000.0);
    assert!(
        link_data_tunnel(
            &network_state,
            &mut peers,
            "browser-1",
            EdgeLane::Interactive,
            2_000.0
        )
        .await
    );
    assert_eq!(peers["browser-1"].paths.edge.last_ack_at_ms, 1_000.0);
    assert_eq!(peers["browser-1"].paths.edge.network_jitter_ewma_ms, 11.0);
}
