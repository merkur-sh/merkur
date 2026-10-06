use super::*;

#[tokio::test]
async fn ignored_perf_configuration_never_lends_another_owner_trace_token() {
    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize::default())
        .expect("test PTY");
    let (terminal_tx, _terminal_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_tx);
    let (event_tx, _event_output) = test_event_sink();
    let mut registry = PeerRegistry::new();
    for id in ["owner", "other"] {
        let mut peer = PeerDisplayState::new(id.into(), PeerTransport::WebTransport);
        peer.signal_session_id = "original-session".into();
        registry.peers.insert(id.into(), peer);
    }
    let (mut prepare, _prepare_rx, _snapshot_rx, _dictionary_rx) = start_display_prepare_worker();
    let start = Instant::now();
    let network = Arc::new(RwLock::new(NetworkState::new()));
    let mut timing = PerfTimingTracker::default();
    let mut original_token = None;
    let mut replacement_token = None;

    // Exercise the actual CTRL decoder/handler, including both peer and
    // signal-session identity, delayed epochs, and disable tombstones.
    for (step, (id, session, enabled, epoch)) in [
        ("owner", "original-session", true, 10_u32),
        ("other", "original-session", false, 11),
        ("owner", "original-session", true, 9),
        ("owner", "original-session", false, 9),
        ("owner", "replacement-session", false, 11),
        ("owner", "replacement-session", true, 10),
        ("owner", "replacement-session", true, 9),
        ("owner", "replacement-session", false, 9),
        ("owner", "replacement-session", false, 11),
        ("owner", "replacement-session", true, 10),
    ]
    .into_iter()
    .enumerate()
    {
        registry.peers.get_mut(id).unwrap().signal_session_id = session.into();
        let mut body = [0; PERF_ENABLE_PAYLOAD_BYTES];
        body[0] = u8::from(enabled);
        body[1..].copy_from_slice(&epoch.to_be_bytes());
        let payload = encode_proto_frame(MSG_TYPE_PERF_ENABLE, &body);
        let msg = PeerMessage {
            input_permit: None,
            peer_node_id: Arc::from(id),
            channel_id: CHANNEL_CTRL,
            payload: bytes::Bytes::new(),
            via_transport: PeerTransport::WebTransport,
            delivery: DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        };
        handle_ctrl_channel(
            &msg,
            &payload,
            &*pair.master,
            &mut terminal,
            &event_tx,
            &mut registry,
            &mut prepare,
            start,
            &network,
            &[],
            &HashMap::new(),
            &mut timing,
        )
        .await;

        match step {
            0 => {
                original_token = timing.trace_token();
                assert!(original_token.is_some());
                assert_eq!(registry.peers[id].perf_trace_token, original_token);
            }
            1 | 4 => {
                assert_eq!(timing.trace_token(), original_token);
                assert!(timing.owns("owner", "original-session"));
                assert_eq!(registry.peers[id].perf_trace_token, None);
            }
            2 | 3 => {
                assert_eq!(timing.trace_token(), original_token);
                assert_eq!(registry.peers[id].perf_trace_token, original_token);
            }
            5 => {
                replacement_token = timing.trace_token();
                assert!(replacement_token.is_some());
                assert_ne!(replacement_token, original_token);
                assert!(timing.owns("owner", "replacement-session"));
                assert_eq!(registry.peers[id].perf_trace_token, replacement_token);
            }
            6 | 7 => {
                assert_eq!(timing.trace_token(), replacement_token);
                assert_eq!(registry.peers[id].perf_trace_token, replacement_token);
            }
            8 | 9 => {
                assert!(!timing.is_enabled());
                assert_eq!(timing.trace_token(), None);
                assert_eq!(registry.peers[id].perf_trace_token, None);
            }
            _ => unreachable!(),
        }
    }
    timing.clear_owner();
}
