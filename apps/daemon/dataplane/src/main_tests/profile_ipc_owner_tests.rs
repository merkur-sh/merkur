use super::*;

#[test]
fn profile_ipc_owner_superseded_end_does_not_stop_the_new_observation() {
    if std::env::var_os("MERKUR_PROFILE_IPC_OWNER_CHILD").is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "profile_ipc_owner_tests::profile_ipc_owner_superseded_end_does_not_stop_the_new_observation"])
            .env("MERKUR_PROFILE_IPC_OWNER_CHILD", "1")
            .status().unwrap();
        assert!(status.success());
        return;
    }
    let (event_tx, _output) = test_event_sink();
    let mut registry = PeerRegistry::new();
    let mut peer = PeerDisplayState::new("profile-peer".into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    peer.signal_session_id = "profile-session".into();
    registry.peers.insert(peer.peer_id.clone(), peer);
    let mut token = None;
    let mut epoch = 0;
    for owner in ["owner-a", "owner-b"] {
        let payload = serde_json::to_vec(&serde_json::json!({
            "command_id": owner, "observation_id": owner, "session_id": "profile-session"
        }))
        .unwrap();
        handle_profile_owner_command(
            CMD_PROFILE_START,
            &payload,
            &registry,
            &event_tx,
            &mut token,
            &mut epoch,
        );
    }
    let current = perf_trace::active_token().expect("B owns the observation");
    assert!(
        profile_capture_token(
            &TraceCaptureOwner::Cli {
                observation_id: "owner-a".into()
            },
            token.as_ref()
        )
        .is_none(),
        "A must not capture B's records"
    );
    perf_trace::record_at(
        current,
        Instant::now(),
        perf_trace::TraceEvent::DisplayMember([42; 16]),
    );
    let payload = br#"{"command_id":"end-a","observation_id":"owner-a"}"#;
    handle_profile_owner_command(
        CMD_PROFILE_END,
        payload,
        &registry,
        &event_tx,
        &mut token,
        &mut epoch,
    );
    assert_eq!(
        perf_trace::active_token(),
        Some(current),
        "A must not end B's observation"
    );
    let capture_token = profile_capture_token(
        &TraceCaptureOwner::Cli {
            observation_id: "owner-b".into(),
        },
        token.as_ref(),
    )
    .expect("B can still capture its observation");
    let snapshot = merkur_trace::capture_owned(capture_token).expect("B owns the capture");
    assert_eq!(snapshot.evidence.len(), 1, "A must leave B undrained");
    assert_eq!(snapshot.evidence[0].fields, [42; 16]);
    perf_trace::end(current);
}
