use super::*;
use crate::network::protocol::CHANNEL_DISPLAY_DATAGRAM;
use crate::network::{self, NetworkState};
use tokio::sync::RwLock;

/// Exercise the production receiver with overlapping source generations. No
/// FIN, reset, timer, or scheduler ordering is required to retire stale bytes.
#[tokio::test]
async fn successor_source_discards_partial_and_late_streams_without_closing_daemon() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let (config, cert) = crate::webtransport::build_server_config(0).unwrap();
        let server = Endpoint::server(config).unwrap();
        let url = format!("https://127.0.0.1:{}", server.local_addr().unwrap().port());
        let client = Endpoint::client(
            ClientConfig::builder()
                .with_bind_default()
                .with_server_certificate_hashes([Sha256Digest::new(cert.cert_hash)])
                .build(),
        )
        .unwrap();
        let (edge, daemon) = tokio::join!(
            async { server.accept().await.await.unwrap().accept().await.unwrap() },
            client.connect(&url)
        );
        let daemon = Arc::new(daemon.unwrap());
        let (tx, mut rx) = mpsc::channel(8);
        let receiver = tokio::spawn(run_reliable_acceptor(
            daemon.clone(),
            EdgeIngress {
                tx,
                peer_node_id: Arc::from("peer"),
                identity: EdgeIngressIdentity {
                    session_id: Arc::from("session"),
                    generation: 1,
                    lane: EdgeLane::Signaling,
                },
            },
            EdgeLane::Signaling,
        ));
        let mut old = edge.open_uni().await.unwrap().await.unwrap();
        old.write_all(&[0, 0, 0, 0, 0, 0, 0, 1, CHANNEL_SIGNALING])
            .await
            .unwrap();
        old.write_all(b"\0\0\0\x01a").await.unwrap();
        assert_eq!(rx.recv().await.unwrap().payload.as_ref(), b"a");
        old.write_all(b"\0\0\x10").await.unwrap(); // incomplete old record
        let mut late = edge.open_uni().await.unwrap().await.unwrap();
        late.write_all(&[0, 0, 0, 0]).await.unwrap(); // incomplete old prefix
        let mut fresh = edge.open_uni().await.unwrap().await.unwrap();
        fresh
            .write_all(&[0, 0, 0, 0, 0, 0, 0, 2, CHANNEL_SIGNALING])
            .await
            .unwrap();
        fresh.write_all(b"\0\0\0\x01b").await.unwrap();
        assert_eq!(rx.recv().await.unwrap().payload.as_ref(), b"b");
        late.write_all(&[0, 0, 0, 1, CHANNEL_SIGNALING])
            .await
            .unwrap();
        fresh.write_all(b"\0\0\0\x01c").await.unwrap();
        assert_eq!(rx.recv().await.unwrap().payload.as_ref(), b"c");
        assert!(daemon.quic_connection().close_reason().is_none());
        assert!(!receiver.is_finished());
        let mut duplicate = edge.open_uni().await.unwrap().await.unwrap();
        duplicate
            .write_all(&[0, 0, 0, 0, 0, 0, 0, 2, CHANNEL_SIGNALING])
            .await
            .unwrap();
        let error = receiver.await.unwrap().unwrap_err();
        assert_eq!(
            error.failure.kind,
            EdgeReliableLaneFailureKind::DuplicateChannel
        );
        daemon.close(wtransport::VarInt::from_u32(0), b"test complete");
    })
    .await
    .expect("source-generation cut is event-driven and bounded");
}

/// Actual QUIC loss recovery, not a mock blocked writer: only the data
/// connection loses return packets. This deliberately does not partition the
/// common proxy used by the browser E2E harness.
#[tokio::test]
async fn rebind_answer_crosses_the_wire_while_display_exceeds_its_congestion_window() {
    tokio::time::timeout(Duration::from_secs(10), async {
        for lane in [EdgeLane::Interactive, EdgeLane::Bulk] {
            prove_isolation(lane).await;
        }
    })
    .await
    .expect("bounded real-QUIC congestion regression");
}

async fn prove_isolation(lane: EdgeLane) {
    let (config, cert) = crate::webtransport::build_server_config(0).expect("server config");
    let server = Arc::new(Endpoint::server(config).expect("server"));
    let server_addr: std::net::SocketAddr = format!(
        "127.0.0.1:{}",
        server.local_addr().expect("server address").port()
    )
    .parse()
    .expect("address");
    let proxy = tokio::net::UdpSocket::bind("127.0.0.1:0")
        .await
        .expect("data proxy");
    let proxy_addr = proxy.local_addr().expect("proxy address");
    let blackhole = Arc::new(AtomicBool::new(false));
    let drop_returns = Arc::clone(&blackhole);
    let proxy_task = tokio::spawn(async move {
        let mut client_addr = None;
        let mut packet = vec![0; 65_536];
        loop {
            let (length, from) = proxy.recv_from(&mut packet).await.expect("proxy receive");
            if from == server_addr {
                if !drop_returns.load(Ordering::Acquire)
                    && let Some(client) = client_addr
                {
                    proxy
                        .send_to(&packet[..length], client)
                        .await
                        .expect("proxy return");
                }
            } else {
                client_addr = Some(from);
                proxy
                    .send_to(&packet[..length], server_addr)
                    .await
                    .expect("proxy forward");
            }
        }
    });
    let (accepted_tx, mut accepted_rx) = mpsc::channel(2);
    let accept_server = Arc::clone(&server);
    let accept_task = tokio::spawn(async move {
        let mut tasks = JoinSet::new();
        for _ in 0..2 {
            let incoming = accept_server.accept().await;
            let accepted_tx = accepted_tx.clone();
            tasks.spawn(async move {
                let conn = incoming.await.expect("request").accept().await.expect("accept");
                let (mut lifecycle, mut routing) = conn.accept_bi().await.expect("routing stream");
                let mut length = [0; 4];
                routing.read_exact(&mut length).await.expect("routing header");
                let mut body = vec![0; u32::from_be_bytes(length) as usize];
                routing.read_exact(&mut body).await.expect("routing body");
                let routed: serde_json::Value = serde_json::from_slice(&body).expect("routing JSON");
                let (quote_send, mut quote_recv) = conn.accept_bi().await.expect("quote stream");
                let mut quote_preface = vec![0; DELIVERY_QUOTE_STREAM_PREFACE.len()];
                quote_recv.read_exact(&mut quote_preface).await.expect("quote preface");
                assert_eq!(quote_preface, DELIVERY_QUOTE_STREAM_PREFACE);
                let present = br#"{"type":"counterpart_present","present":true,"counterpart_attachment_id":1}"#;
                lifecycle.write_all(&(present.len() as u32).to_be_bytes()).await.expect("lifecycle header");
                lifecycle.write_all(present).await.expect("lifecycle body");
                accepted_tx.send((routed["session_id"].as_str().expect("session").to_owned(),
                    conn, (lifecycle, routing, quote_send, quote_recv))).await.expect("test owner");
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.expect("accept task");
        }
    });
    // The production dial/setup and per-channel writer run on each connection.
    let signal_url = format!("https://{server_addr}");
    let data_url = format!("https://{proxy_addr}");
    let hashes = [cert.cert_hash];
    let probes = wtransport::quinn::ProbeGroup::new();
    let credential = crate::edge_tunnel::EdgeAdmission::for_test()
        .current()
        .expect("test credential");
    let (signaling, data) = tokio::join!(
        EdgeTunnel::connect(
            &signal_url,
            &hashes,
            "test#signaling",
            EdgeLane::Signaling,
            &probes,
            &credential,
        ),
        EdgeTunnel::connect(&data_url, &hashes, "test", lane, &probes, &credential),
    );
    let signaling = Arc::new(signaling.expect("signaling connection"));
    let data = Arc::new(data.expect("data connection"));
    let first = accepted_rx.recv().await.expect("first connection");
    let second = accepted_rx.recv().await.expect("second connection");
    let signal_receiver = if first.0.ends_with("#signaling") {
        &first.1
    } else {
        &second.1
    };
    let data_receiver = if first.0.ends_with("#signaling") {
        &second.1
    } else {
        &first.1
    };
    while signaling.counterpart_absent.load(Ordering::Acquire)
        || data.counterpart_absent.load(Ordering::Acquire)
    {
        tokio::task::yield_now().await;
    }

    assert!(
        signaling
            .send_reliable(CHANNEL_DISPLAY_COMMIT, ReliablePayload::Heap(vec![1]))
            .is_err()
    );
    assert!(
        !signaling.send_framed_datagram(&bytes::Bytes::from_static(&[CHANNEL_DISPLAY_DATAGRAM, 1]))
    );
    assert!(
        data.send_reliable(CHANNEL_SIGNALING, ReliablePayload::Heap(vec![1]))
            .is_err()
    );
    blackhole.store(true, Ordering::Release);
    let mut next_record = 0u32;
    let mut fill_display = || {
        let mut admitted = 0;
        loop {
            let mut payload = vec![0x5a; 64 * 1024];
            payload[..4].copy_from_slice(&next_record.to_be_bytes());
            if data
                .send_reliable(CHANNEL_DISPLAY_COMMIT, ReliablePayload::Heap(payload))
                .is_err()
            {
                break;
            }
            next_record += 1;
            admitted += 1;
        }
        admitted
    };
    let mut admitted_records = fill_display();
    assert!(admitted_records > 0);
    loop {
        let path = data.quic_delivery_state().expect("real QUIC state");
        if path.pto_count >= 2 && path.bytes_in_flight > path.cwnd {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    // Full at the instant of the request, not merely at some earlier instant.
    admitted_records += fill_display();
    assert!(data.reliable_queued_bytes.load(Ordering::Acquire) > 0);
    let network = Arc::new(RwLock::new(NetworkState::new()));
    network::register_edge_signaling(&network, "browser", Arc::clone(&signaling)).await;
    let response = serde_json::to_vec(&serde_json::json!({
        "type": "session_rebound", "ok": true,
        "ciphertext": "A".repeat(2091), "daemon_nonce": "B".repeat(43),
        "mac": "C".repeat(86), "noise_msg2": "D".repeat(128),
        "next_expected_input_seq": 17,
    }))
    .expect("full-sized rebind response");
    // Four RTOs at the browser's minimum RTO. No harness RTT is tuned here.
    let budget = Duration::from_secs_f64(
        4.0 * crate::session::policy::SessionPolicy::RTO_FLOOR_MS / 1_000.0,
    );
    let mut signal_stream = tokio::time::timeout(budget, async {
        assert!(network::send_signaling_to_peer(&network, "browser", response.clone()).await);
        let mut stream = signal_receiver
            .accept_uni()
            .await
            .expect("answer reaches wire");
        let mut prefix = [0; 1];
        stream.read_exact(&mut prefix).await.expect("signal prefix");
        assert_eq!(prefix, [CHANNEL_SIGNALING]);
        for attempt in 0..2 {
            if attempt != 0 {
                assert!(
                    network::send_signaling_to_peer(&network, "browser", response.clone()).await
                );
            }
            let mut length = [0; 4];
            stream
                .read_exact(&mut length)
                .await
                .expect("response header");
            let mut received = vec![0; u32::from_be_bytes(length) as usize];
            stream
                .read_exact(&mut received)
                .await
                .expect("complete response");
            assert_eq!(received, response);
        }
        let path = data.quic_delivery_state().expect("data still live");
        assert!(path.pto_count >= 2 && path.bytes_in_flight > path.cwnd);
        stream
    })
    .await
    .expect("rebind response must beat the unchanged silent-attempt budget");
    // Loss and a full congestion window do not retire a live data lane or
    // discard its admitted records. Restoring return traffic drains that same
    // connection, without a redial or a replay onto a successor.
    assert!(
        data.conn
            .as_ref()
            .unwrap()
            .quic_connection()
            .close_reason()
            .is_none()
    );
    blackhole.store(false, Ordering::Release);
    let mut display_stream = data_receiver
        .accept_uni()
        .await
        .expect("retained display lane");
    let mut prefix = [0; 1];
    display_stream
        .read_exact(&mut prefix)
        .await
        .expect("display prefix");
    assert_eq!(prefix, [CHANNEL_DISPLAY_COMMIT]);
    for expected in 0..admitted_records as u32 {
        let mut length = [0; 4];
        display_stream
            .read_exact(&mut length)
            .await
            .expect("retained record length");
        assert_eq!(u32::from_be_bytes(length), 64 * 1024);
        let mut payload = vec![0; 64 * 1024];
        display_stream
            .read_exact(&mut payload)
            .await
            .expect("retained record");
        assert_eq!(&payload[..4], &expected.to_be_bytes());
        assert!(payload[4..].iter().all(|byte| *byte == 0x5a));
    }
    assert!(network::send_signaling_to_peer(&network, "browser", response.clone()).await);
    tokio::time::timeout(budget, async {
        let mut length = [0; 4];
        signal_stream
            .read_exact(&mut length)
            .await
            .expect("post-recovery header");
        let mut received = vec![0; u32::from_be_bytes(length) as usize];
        signal_stream
            .read_exact(&mut received)
            .await
            .expect("post-recovery response");
        assert_eq!(received, response);
    })
    .await
    .expect("data recovery must leave signaling usable");
    data.close();
    signaling.close();
    proxy_task.abort();
    accept_task.await.expect("accept loop");
}

/// The edge gathers contention evidence exactly while this process profiles:
/// the quote stream's request half carries the profiling state, current first,
/// then one byte per change.
#[tokio::test]
async fn contention_requests_mirror_profiling_onto_the_quote_stream() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let (config, cert) = crate::webtransport::build_server_config(0).unwrap();
        let server = Endpoint::server(config).unwrap();
        let url = format!("https://127.0.0.1:{}", server.local_addr().unwrap().port());
        let client = Endpoint::client(
            ClientConfig::builder()
                .with_bind_default()
                .with_server_certificate_hashes([Sha256Digest::new(cert.cert_hash)])
                .build(),
        )
        .unwrap();
        let (edge, daemon) = tokio::join!(
            async { server.accept().await.await.unwrap().accept().await.unwrap() },
            client.connect(&url)
        );
        let daemon = daemon.unwrap();
        let (profiling, changes) = watch::channel(false);
        let (send, _quotes) = daemon.open_bi().await.unwrap().await.unwrap();
        let requests = spawn_contention_requests(send, changes);
        let (_edge_quotes, mut received) = edge.accept_bi().await.unwrap();
        let mut request = [0u8; 1];
        received.read_exact(&mut request).await.unwrap();
        assert_eq!(request, [0], "not profiling: nothing asked");
        profiling.send_replace(true);
        received.read_exact(&mut request).await.unwrap();
        assert_eq!(request, [1], "profiling asks");
        profiling.send_replace(false);
        received.read_exact(&mut request).await.unwrap();
        assert_eq!(request, [0], "and withdraws");
        requests.abort();
    })
    .await
    .expect("contention requests must follow profiling");
}
