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
                crate::attach_ticket::TEST_ACCOUNT_ID,
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
                crate::attach_ticket::TEST_ACCOUNT_ID,
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
                    .attach(
                        &preface.session_id,
                        preface.role,
                        &preface.daemon_id,
                        test_tenant(),
                    )
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
                run_spliced_session(
                    edge.clone(),
                    registry,
                    preface,
                    test_tenant(),
                    control,
                    None,
                    None,
                    None,
                )
                .await;
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

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Test assertions panic on incorrect behavior while setup propagates I/O errors."
)]
async fn candidate_promotion_preserves_pending_resume() -> Result<(), Box<dyn std::error::Error>> {
    use crate::egress_budget::BudgetState;
    use std::future::Future;
    use std::task::Poll;
    let (server, client, url) = retirement_tests::endpoints();
    let accept = async { server.accept().await.await?.accept().await };
    let (edge, browser) = tokio::join!(accept, client.connect(&url));
    let edge = edge?;
    let browser = browser?;
    let registry = SpliceRegistry::new();
    registry.apply_egress_state(BudgetState::SignalingOnly);
    let budget = RelayDataControl::new(&registry);
    let (mut control, _inbound) = edge.open_bi().await?.await?;
    let (complete, ready) = tokio::sync::oneshot::channel();
    let proof = async {
        ready.await.map_err(|_closed| ())?;
        // Reopen in the proof's final poll: even a controls-first select has
        // already seen no transition, and cannot deliver this before promotion.
        registry.apply_egress_state(BudgetState::Open);
        Ok::<_, ()>(())
    };
    let read_pause = async {
        let (_send, mut events) = browser.accept_bi().await?;
        assert_eq!(
            tests::read_test_control(&mut events).await,
            SpliceControlEvent::RelayDataPaused { paused: true }
        );
        complete
            .send(())
            .map_err(|_proof| "proof ended before pause")?;
        Ok::<_, Box<dyn std::error::Error>>(events)
    };
    let (promoted, events) = tokio::join!(
        candidate::drive_proof(proof, budget, &mut control),
        read_pause
    );
    let (_, mut budget) = promoted.map_err(|()| "candidate proof failed")?;
    let mut events = events?;
    let next = budget.next();
    tokio::pin!(next);
    assert_eq!(
        std::future::poll_fn(|cx| Poll::Ready(next.as_mut().poll(cx))).await,
        Poll::Ready(false),
        "promotion discarded pending relay resume"
    );
    write_splice_control(
        &mut control,
        &SpliceControlEvent::RelayDataPaused { paused: false },
    )
    .await?;
    assert_eq!(
        tests::read_test_control(&mut events).await,
        SpliceControlEvent::RelayDataPaused { paused: false }
    );
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Test assertions panic on incorrect behavior while setup propagates I/O errors."
)]
async fn failed_candidate_controls_detach_promoted_browser()
-> Result<(), Box<dyn std::error::Error>> {
    use crate::egress_budget::BudgetState;
    use crate::splice::AttachmentLifecycle;
    let (server, client, url) = retirement_tests::endpoints();
    let accept = async { server.accept().await.await?.accept().await };
    let (edge, browser) = tokio::join!(accept, client.connect(&url));
    let edge = edge?;
    let browser = browser?;
    let registry = SpliceRegistry::new();
    let session = "failed-controls#signaling";
    let daemon_id = crate::attach_ticket::TEST_DAEMON_ID;
    let daemon = registry
        .attach(session, Role::Daemon, daemon_id, test_tenant())
        .map_err(|error| format!("{error:?}"))?;
    let (mut control, _inbound) = edge.open_bi().await?.await?;
    write_splice_control(
        &mut control,
        &SpliceControlEvent::CounterpartPresent {
            present: true,
            counterpart_attachment_id: Some(daemon.attachment_id.as_u64()),
        },
    )
    .await?;
    let (_send, mut events) = browser.accept_bi().await?;
    tests::read_test_control(&mut events).await;
    events.stop(VarInt::from_u32(0));
    control.stopped().await;
    let (promoted, ready) = tokio::sync::oneshot::channel();
    let response = async {
        promoted.send(())?;
        // The final proof response is held at its await, as with exhausted
        // stream credit. This exercises cancellation without relying on a QUIC
        // window size or timing to manufacture backpressure.
        std::future::pending::<Result<(), ()>>().await
    };
    let proof = candidate::complete_promotion(
        &registry,
        session,
        daemon_id,
        test_tenant(),
        daemon.attachment_id,
        response,
    );
    let fail_controls = async {
        ready.await?;
        assert!(matches!(
            *daemon.lifecycle_rx.borrow(),
            Some(AttachmentLifecycle::CounterpartAttached { .. })
        ));
        registry.apply_egress_state(BudgetState::SignalingOnly);
        Ok::<_, Box<dyn std::error::Error>>(())
    };
    let (admitted, failed) = tokio::join!(
        candidate::drive_proof(proof, RelayDataControl::new(&registry), &mut control),
        fail_controls
    );
    failed?;
    assert!(admitted.is_err(), "reset controls must end admission");
    assert!(
        matches!(
            *daemon.lifecycle_rx.borrow(),
            Some(AttachmentLifecycle::CounterpartDetached { .. })
        ),
        "failed candidate controls left a promoted browser attached"
    );
    assert!(!daemon.datagram_route.route(crate::splice::Frame::datagram(
        bytes::Bytes::from_static(b"ownerless")
    )));
    let attached = candidate::complete_promotion(
        &registry,
        session,
        daemon_id,
        test_tenant(),
        daemon.attachment_id,
        async { Ok(()) },
    )
    .await
    .map_err(|()| "promotion failed")?;
    assert!(
        matches!(*daemon.lifecycle_rx.borrow(), Some(AttachmentLifecycle::CounterpartAttached { attachment_id }) if attachment_id == attached.attachment_id)
    );
    registry.detach(session, Role::Browser, attached.attachment_id);
    Ok(())
}
