//! What an unauthenticated signaling frame can make the dataplane tell the
//! daemon. The daemon stops its sidecar on an event it cannot validate, so a
//! frame that needs no authentication must never produce one.
use super::*;

/// The `session_rebind` events in a captured `[kind:u8][len:u32][json]` stream.
fn rebind_events(bytes: &[u8]) -> Vec<serde_json::Value> {
    let mut events = Vec::new();
    let mut rest = bytes;
    while let Some((&[kind, a, b, c, d], tail)) = rest.split_first_chunk::<5>() {
        let (body, tail) = tail.split_at(u32::from_be_bytes([a, b, c, d]) as usize);
        if kind == ipc::events::EVT_SESSION_REBIND {
            events.push(serde_json::from_slice(body).expect("rebind event json"));
        }
        rest = tail;
    }
    assert!(rest.is_empty(), "truncated frame in capture");
    events
}

/// A frame a peer can send before it authenticates costs a bounded number of
/// log lines, whatever it sends afterwards.
#[test]
fn one_kind_of_warning_is_logged_sixteen_times_and_then_not() {
    let seen = WarningCount::new(0);
    assert!((0..16).all(|_| within_warning_budget(&seen)));
    assert!((0..1_000).all(|_| !within_warning_budget(&seen)));
}

#[tokio::test]
async fn a_malformed_rebind_envelope_is_counted_and_reports_no_id_the_daemon_refuses() {
    let (event_tx, mut event_output, captured) = ipc::events::test_capturing_event_sink();
    let mut rebind_telemetry = session::rebind_flow::RebindTelemetry::new(event_tx.clone());
    let mut registry = PeerRegistry::new();
    let (terminal_event_tx, _terminal_event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_event_tx);
    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    let (identity_completion_tx, _identity_completion_rx) = mpsc::channel(1);
    let peer: Arc<str> = Arc::from("browser-node");
    let over_long = format!(
        r#"{{"type":"session_rebind","session_id":"{}"}}"#,
        "s".repeat(merkur_wire::signaling::MAX_SESSION_ID_BYTES + 1)
    );
    let envelopes = [
        r#"{"type":"session_rebind"}"#,
        r#"{"type":"session_rebind","session_id":""}"#,
        r#"{"type":"session_rebind","session_id":7}"#,
        over_long.as_str(),
        r#"{"type":"session_rebind","session_id":"session-from-server"}"#,
    ];
    for envelope in envelopes {
        handle_signaling_message(
            &peer,
            "browser-node",
            envelope.as_bytes(),
            &None,
            &None,
            &None,
            &network_state,
            &event_tx,
            &mut rebind_telemetry,
            &mut registry,
            &mut terminal,
            0.0,
            &None,
            None,
            &[],
            true,
            &identity_completion_tx,
            None,
        )
        .await;
    }
    assert_eq!(
        rebind_telemetry.tallies().envelopes_rejected,
        envelopes.len() as u64,
        "every rejected rebind envelope is counted"
    );

    event_output
        .shutdown()
        .await
        .expect("event output shutdown");
    let events = rebind_events(&captured.lock().unwrap());
    for event in &events {
        let session_id = event["session_id"].as_str().expect("a string session id");
        assert!(
            merkur_wire::signaling::is_session_id(session_id),
            "an event the daemon treats as fatal: session id of {} bytes",
            session_id.len()
        );
    }
    assert_eq!(
        events.len(),
        1,
        "only the envelope naming an admissible session is reported"
    );
    assert_eq!(events[0]["session_id"], "session-from-server");
    assert_eq!(events[0]["outcome"], "envelope_rejected");
}
