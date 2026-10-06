use super::*;
use wtransport::ClientConfig;
use wtransport::tls::Sha256Digest;

#[tokio::test]
async fn signaling_only_refuses_primary_data_after_preface() {
    for label in ["budget", "budget#bulk"] {
        let cert = EdgeCert::generate(&["localhost"]).expect("test edge certificate");
        let cert_hash = cert.cert_hash;
        let server = Arc::new(
            build_server(
                &cert,
                "127.0.0.1:0".parse().expect("bind address"),
                &EndpointSecret::generate().expect("secret"),
            )
            .expect("test edge server"),
        );
        let port = server.local_addr().expect("server address").port();
        let (_state, receiver) =
            tokio::sync::watch::channel(crate::egress_budget::BudgetState::SignalingOnly);
        let accept_task = tokio::spawn(accept_loop(
            server,
            SpliceRegistry::new(),
            crate::attach_ticket::test_key(),
            receiver,
        ));
        let client = Endpoint::client(
            ClientConfig::builder()
                .with_bind_default()
                .with_server_certificate_hashes([Sha256Digest::new(cert_hash)])
                .build(),
        )
        .expect("test client endpoint");
        let connection = client
            .connect(format!("https://127.0.0.1:{port}"))
            .await
            .expect("peer connects");
        let (mut send, _recv) = connection
            .open_bi()
            .await
            .expect("open preface stream")
            .await
            .expect("establish preface stream");
        let ticket = crate::attach_ticket::test_key()
            .issue(
                crate::attach_ticket::TicketRole::Browser,
                crate::attach_ticket::TEST_DAEMON_ID,
                "budget",
                0,
            )
            .expect("ticket");
        let json = serde_json::to_vec(&RoutingPreface {
            session_id: label.to_string(),
            role: Role::Browser,
            version: PREFACE_VERSION,
            attachment: RoutingAttachment::Primary,
            daemon_id: crate::attach_ticket::TEST_DAEMON_ID.to_string(),
            ticket,
        })
        .expect("serialize preface");
        send.write_all(&(json.len() as u32).to_be_bytes())
            .await
            .expect("write preface length");
        send.write_all(&json).await.expect("write preface body");
        let closed = tokio::time::timeout(Duration::from_secs(3), connection.closed())
            .await
            .expect("the edge closes a data attachment");
        match closed {
            wtransport::error::ConnectionError::ApplicationClosed(close) => {
                assert_eq!(close.code(), VarInt::from_u32(EGRESS_BUDGET_CLOSE_CODE));
                assert_eq!(close.reason(), EGRESS_BUDGET_CLOSE_REASON)
            }
            other => panic!("closed for another reason: {other:?}"),
        }
        accept_task.abort();
    }
}

#[tokio::test]
async fn stopped_ignores_connections_and_rollover_reopens() {
    use crate::egress_budget::BudgetState;
    let cert = EdgeCert::generate(&["localhost"]).expect("certificate");
    let server = Arc::new(
        build_server(
            &cert,
            "127.0.0.1:0".parse().unwrap(),
            &EndpointSecret::generate().unwrap(),
        )
        .unwrap(),
    );
    let port = server.local_addr().unwrap().port();
    let (state, receiver) = tokio::sync::watch::channel(BudgetState::Stopped);
    let accept_task = tokio::spawn(accept_loop(
        server,
        SpliceRegistry::new(),
        crate::attach_ticket::test_key(),
        receiver,
    ));
    let client = Endpoint::client(
        ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([Sha256Digest::new(cert.cert_hash)])
            .build(),
    )
    .unwrap();
    let connecting = client.connect(format!("https://127.0.0.1:{port}"));
    tokio::pin!(connecting);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut connecting)
            .await
            .is_err()
    );
    state.send_replace(BudgetState::SignalingOnly);
    let connection = tokio::time::timeout(Duration::from_secs(3), &mut connecting)
        .await
        .unwrap()
        .unwrap();
    let (mut send, mut recv) = connection.open_bi().await.unwrap().await.unwrap();
    let json = serde_json::to_vec(&RoutingPreface {
        session_id: "budget#signaling".into(),
        role: Role::Browser,
        version: PREFACE_VERSION,
        attachment: RoutingAttachment::Primary,
        daemon_id: crate::attach_ticket::TEST_DAEMON_ID.into(),
        ticket: crate::attach_ticket::test_key()
            .issue(
                crate::attach_ticket::TicketRole::Browser,
                crate::attach_ticket::TEST_DAEMON_ID,
                "budget",
                0,
            )
            .unwrap(),
    })
    .unwrap();
    send.write_all(&(json.len() as u32).to_be_bytes())
        .await
        .unwrap();
    send.write_all(&json).await.unwrap();
    let mut byte = [0];
    tokio::time::timeout(Duration::from_secs(3), recv.read_exact(&mut byte))
        .await
        .unwrap()
        .unwrap();
    state.send_replace(BudgetState::Stopped);
    let closed = tokio::time::timeout(Duration::from_secs(3), connection.closed())
        .await
        .unwrap();
    match closed {
        wtransport::error::ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.code(), VarInt::from_u32(EGRESS_BUDGET_CLOSE_CODE));
            assert_eq!(close.reason(), EGRESS_BUDGET_CLOSE_REASON)
        }
        other => panic!("unexpected close: {other:?}"),
    }
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            client.connect(format!("https://127.0.0.1:{port}"))
        )
        .await
        .is_err()
    );
    accept_task.abort();
}

fn budget_harness(
    state: crate::egress_budget::BudgetState,
) -> (
    Endpoint<wtransport::endpoint::endpoint_side::Client>,
    String,
    SpliceRegistry,
    tokio::sync::watch::Sender<crate::egress_budget::BudgetState>,
    tokio::task::JoinHandle<()>,
) {
    let cert = EdgeCert::generate(&["localhost"]).unwrap();
    let server = Arc::new(
        build_server(
            &cert,
            "127.0.0.1:0".parse().unwrap(),
            &EndpointSecret::generate().unwrap(),
        )
        .unwrap(),
    );
    let url = format!("https://127.0.0.1:{}", server.local_addr().unwrap().port());
    let registry = SpliceRegistry::new();
    let (budget, receiver) = tokio::sync::watch::channel(state);
    let task = tokio::spawn(accept_loop(
        server,
        registry.clone(),
        crate::attach_ticket::test_key(),
        receiver,
    ));
    let client = Endpoint::client(
        ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([Sha256Digest::new(cert.cert_hash)])
            .build(),
    )
    .unwrap();
    (client, url, registry, budget, task)
}

async fn assert_budget_close(connection: &wtransport::Connection) {
    match tokio::time::timeout(Duration::from_secs(3), connection.closed())
        .await
        .unwrap()
    {
        wtransport::error::ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.code(), VarInt::from_u32(EGRESS_BUDGET_CLOSE_CODE));
            assert_eq!(close.reason(), EGRESS_BUDGET_CLOSE_REASON);
        }
        other => panic!("unexpected close: {other:?}"),
    }
}

#[tokio::test]
async fn relay_data_pause_attach_and_rollover_are_signaling_only() {
    use crate::egress_budget::BudgetState;
    for initial in [BudgetState::Open, BudgetState::SignalingOnly] {
        let (client, url, _registry, budget, task) = budget_harness(initial);
        let (signaling, _send, mut recv, _quote) =
            tests::attach_test_peer(&client, &url, "pause#signaling", Role::Browser).await;
        assert!(matches!(
            tests::read_test_lifecycle(&mut recv).await,
            SpliceControlEvent::CounterpartPresent { present: false, .. }
        ));
        if initial == BudgetState::SignalingOnly {
            assert_eq!(
                tests::read_test_lifecycle(&mut recv).await,
                SpliceControlEvent::RelayDataPaused { paused: true }
            );
            budget.send_replace(BudgetState::Open);
            assert_eq!(
                tests::read_test_lifecycle(&mut recv).await,
                SpliceControlEvent::RelayDataPaused { paused: false }
            );
        } else {
            // The browser's proven address follows its presence. With no
            // counterpart there can be no probe events, and Open adds zero bytes.
            assert!(matches!(
                tests::read_test_control(&mut recv).await,
                SpliceControlEvent::ObservedPath { .. }
            ));
            let mut byte = [0];
            assert!(
                tokio::time::timeout(Duration::from_millis(50), recv.read_exact(&mut byte))
                    .await
                    .is_err()
            );
        }
        let (data, _data_send, mut data_recv, _) =
            tests::attach_test_peer(&client, &url, "pause", Role::Browser).await;
        assert!(matches!(
            tests::read_test_lifecycle(&mut data_recv).await,
            SpliceControlEvent::CounterpartPresent { .. }
        ));
        budget.send_replace(BudgetState::SignalingOnly);
        assert_eq!(
            tests::read_test_lifecycle(&mut recv).await,
            SpliceControlEvent::RelayDataPaused { paused: true }
        );
        assert_budget_close(&data).await;
        budget.send_replace(BudgetState::Open);
        assert_eq!(
            tests::read_test_lifecycle(&mut recv).await,
            SpliceControlEvent::RelayDataPaused { paused: false }
        );
        budget.send_replace(BudgetState::Stopped);
        assert_budget_close(&signaling).await;
        task.abort();
    }
}

#[tokio::test]
async fn relay_data_pause_reaches_a_candidate_waiting_for_its_daemon() {
    use crate::egress_budget::BudgetState;
    let (client, url, _registry, budget, task) = budget_harness(BudgetState::SignalingOnly);
    let connection = client.connect(url).await.unwrap();
    let (mut send, mut recv) = connection.open_bi().await.unwrap().await.unwrap();
    let preface = RoutingPreface {
        session_id: "candidate#signaling".into(),
        role: Role::Browser,
        version: PREFACE_VERSION,
        attachment: RoutingAttachment::Candidate {
            nonce: "A".repeat(43),
        },
        daemon_id: crate::attach_ticket::TEST_DAEMON_ID.into(),
        ticket: crate::attach_ticket::test_ticket(
            crate::attach_ticket::TicketRole::Browser,
            "candidate#signaling",
        ),
    };
    let json = serde_json::to_vec(&preface).unwrap();
    send.write_all(&(json.len() as u32).to_be_bytes())
        .await
        .unwrap();
    send.write_all(&json).await.unwrap();
    assert!(matches!(
        tests::read_test_lifecycle(&mut recv).await,
        SpliceControlEvent::CounterpartPresent { present: false, .. }
    ));
    assert_eq!(
        tests::read_test_lifecycle(&mut recv).await,
        SpliceControlEvent::RelayDataPaused { paused: true }
    );
    budget.send_replace(BudgetState::Open);
    assert_eq!(
        tests::read_test_lifecycle(&mut recv).await,
        SpliceControlEvent::RelayDataPaused { paused: false }
    );
    budget.send_replace(BudgetState::Stopped);
    assert_budget_close(&connection).await;
    task.abort();
}

#[tokio::test]
async fn budget_attach_and_bind_races_use_the_typed_close() {
    use crate::egress_budget::BudgetState;
    for bind in [false, true] {
        let cert = EdgeCert::generate(&["localhost"]).unwrap();
        let server = build_server(
            &cert,
            "127.0.0.1:0".parse().unwrap(),
            &EndpointSecret::generate().unwrap(),
        )
        .unwrap();
        let client = Endpoint::client(
            ClientConfig::builder()
                .with_bind_default()
                .with_server_certificate_hashes([Sha256Digest::new(cert.cert_hash)])
                .build(),
        )
        .unwrap();
        let url = format!("https://127.0.0.1:{}", server.local_addr().unwrap().port());
        let registry = SpliceRegistry::new();
        let task = tokio::spawn(async move {
            let edge = Arc::new(server.accept().await.await.unwrap().accept().await.unwrap());
            let (preface, control, _inbound) = read_routing_preface(&edge).await.unwrap();
            if bind {
                let handle = registry
                    .attach(&preface.session_id, preface.role, &preface.daemon_id)
                    .unwrap();
                registry.apply_egress_state(BudgetState::SignalingOnly);
                registry.bind_transport(
                    &preface.session_id,
                    preface.role,
                    handle.attachment_id,
                    edge.quic_connection(),
                );
            } else {
                registry.apply_egress_state(BudgetState::SignalingOnly);
                run_spliced_session(edge.clone(), registry, preface, control, None, None).await;
            }
            // Keep the endpoint alive until the peer acknowledges the close.
            server.wait_idle().await;
        });
        let (connection, _send, _recv, _) =
            tests::attach_test_peer(&client, &url, "race", Role::Browser).await;
        assert_budget_close(&connection).await;
        task.abort();
    }
}

#[tokio::test]
async fn relay_data_control_keeps_the_newest_resume_and_stopped_sends_no_event() {
    use crate::egress_budget::BudgetState;
    let registry = SpliceRegistry::new();
    let mut control = RelayDataControl::new(&registry);
    assert!(
        tokio::time::timeout(Duration::from_millis(1), control.next())
            .await
            .is_err()
    );
    registry.apply_egress_state(BudgetState::SignalingOnly);
    registry.apply_egress_state(BudgetState::Open);
    assert!(!control.next().await);
    registry.apply_egress_state(BudgetState::SignalingOnly);
    assert!(control.next().await);
    registry.apply_egress_state(BudgetState::Stopped);
    assert!(
        tokio::time::timeout(Duration::from_millis(1), control.next())
            .await
            .is_err()
    );
}
