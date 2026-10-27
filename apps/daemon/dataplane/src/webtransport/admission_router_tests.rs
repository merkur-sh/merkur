//! Scoped helper listener/upgrade checks. Each fixture supplies an established
//! peer and key; initial capability/bootstrap and terminal continuity are tested
//! by the full session harness, not by this component check.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use merkur_wire::signaling::ClientSignal;
use wtransport::quinn::AsyncUdpSocket;

tokio::task_local! {
    static OFFER_GATE: (String, Arc<tokio::net::TcpListener>);
}

/// An owned-lab barrier before the real helper send. It changes scheduling only;
/// production allocation, discovery, packets and authentication run unmodified.
pub(super) async fn before_offer(port: u16) {
    if let Ok((output, listener)) = OFFER_GATE.try_with(Clone::clone) {
        std::fs::write(
            output,
            serde_json::json!({ "port": port, "continue": listener.local_addr().unwrap().port() })
                .to_string(),
        )
        .unwrap();
        listener.accept().await.unwrap();
    }
}

async fn write_record(stream: &mut wtransport::SendStream, bytes: &[u8]) {
    stream
        .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
        .await
        .unwrap();
    stream.write_all(bytes).await.unwrap();
}

async fn read_record(stream: &mut wtransport::RecvStream) -> Vec<u8> {
    let mut length = [0; 4];
    stream.read_exact(&mut length).await.unwrap();
    let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut bytes).await.unwrap();
    bytes
}

#[expect(
    clippy::too_many_lines,
    reason = "exercise a real IPv6 helper listener through framed session-key upgrade, adoption and retirement"
)]
async fn ipv6_binding_upgrade(kind: CandidateFlavor) {
    use crate::network::protocol::{CHANNEL_CTRL, CHANNEL_DISPLAY_COMMIT, CHANNEL_PTY};
    use merkur_wire::signaling::{WebtransportUpgradeInit, WebtransportUpgradeProof};
    let (_endpoint, cert, info) = super::super::start_server(0, None).unwrap();
    let hash = cert.cert_hash;
    let state = Arc::new(RwLock::new(WebTransportState::from_server_info(
        cert, &info,
    )));
    let (messages, mut incoming) = mpsc::channel(8);
    let (events, mut event_rx) = mpsc::channel(8);
    let (handle, _) = channel();
    let mut owner = Owner::new(messages.clone(), events.clone(), &handle);
    let mut peer = super::tests::peer();
    peer.browser_address = Some("::1".parse().unwrap());
    peer.upgrade_secret = Some([0x74; 32]);
    let identity = Identity {
        peer: peer.peer_id.clone(),
        session: peer.signal_session_id.clone(),
        rebind: 0,
        manifest: peer.manifest_generation,
        browser: peer.browser_address.unwrap(),
    };
    let claim = Claim::new(identity.clone(), handle.epoch.clone(), 0);
    let (binding, candidate) = prepare_binding(
        &state,
        &info.admission_config,
        None,
        &super::tests::loopback_path(true),
        kind,
        claim.clone(),
        messages,
        events,
        owner.retirements.clone(),
    )
    .await
    .unwrap();
    assert_eq!(candidate["addr"], "::1");
    assert_eq!(candidate["kind"], serde_json::to_value(kind).unwrap());
    let client = wtransport::Endpoint::client(
        wtransport::ClientConfig::builder()
            .with_bind_address("[::1]:0".parse().unwrap())
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(hash)])
            .build(),
    )
    .unwrap();
    let connection = client
        .connect(format!(
            "https://[::1]:{}",
            candidate["port"].as_u64().unwrap()
        ))
        .await
        .unwrap();
    let mut streams = Vec::new();
    for channel in [CHANNEL_CTRL, CHANNEL_PTY, CHANNEL_DISPLAY_COMMIT] {
        let (mut send, recv) = connection.open_bi().await.unwrap().await.unwrap();
        send.write_all(&[channel]).await.unwrap();
        streams.push((send, recv));
    }
    let PeerEvent::WebTransportSession { temp_peer_id, .. } = event_rx.recv().await.unwrap() else {
        panic!("bound session");
    };
    assert!(
        !peer.paths.webtransport.available,
        "a send and TLS handshake grant no session"
    );
    let daemon_identity = Some(
        crate::auth::DaemonIdentity::new(&URL_SAFE_NO_PAD.encode([0x33; 32]), "ipv6-test-daemon")
            .unwrap(),
    );
    let mut peers = PeerMap::from([(peer.peer_id.clone(), peer)]);
    let mut pending = HashMap::new();
    let mut ownership = HashMap::new();
    let init =
        serde_json::json!({ "type": "webtransport_upgrade_init", "browser_node_id": "browser" });
    write_record(&mut streams[0].0, &serde_json::to_vec(&init).unwrap()).await;
    let message = incoming.recv().await.unwrap();
    assert_eq!(message.peer_node_id.as_ref(), temp_peer_id);
    let Some(ClientSignal::WebtransportUpgradeInit(WebtransportUpgradeInit { browser_node_id })) =
        ClientSignal::parse(&message.payload)
    else {
        panic!("upgrade init");
    };
    crate::session::wt_upgrade_flow::handle_wt_upgrade_init(
        &temp_peer_id,
        &WebtransportUpgradeInit { browser_node_id },
        &Some(state.clone()),
        &daemon_identity,
        &peers,
        &mut pending,
        1.0,
    )
    .await;
    let challenge: serde_json::Value =
        serde_json::from_slice(&read_record(&mut streams[0].1).await).unwrap();
    let nonce = challenge["nonce_hex"].as_str().unwrap();
    let transcript = merkur_wire::signaling::webtransport_upgrade_proof_payload(
        nonce,
        "session",
        "browser",
        "ipv6-test-daemon",
        &temp_peer_id,
    );
    let proof = ring::hmac::sign(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA512, &[0x74; 32]),
        transcript.as_bytes(),
    );
    let proof_hex: String = proof
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    write_record(
        &mut streams[0].0,
        &serde_json::to_vec(&serde_json::json!({
        "type": "webtransport_upgrade_proof", "proof_hex": proof_hex }))
        .unwrap(),
    )
    .await;
    let message = incoming.recv().await.unwrap();
    let Some(ClientSignal::WebtransportUpgradeProof(WebtransportUpgradeProof { proof_hex })) =
        ClientSignal::parse(&message.payload)
    else {
        panic!("upgrade proof");
    };
    crate::session::wt_upgrade_flow::handle_wt_upgrade_proof(
        &temp_peer_id,
        &WebtransportUpgradeProof { proof_hex },
        &Some(state.clone()),
        &daemon_identity,
        &mut peers,
        &mut ownership,
        &mut pending,
        2.0,
    )
    .await;
    let ack = read_record(&mut streams[0].1).await;
    assert_eq!(
        crate::network::protocol::decode_proto_frame(&ack)
            .unwrap()
            .0,
        merkur_wire::protocol::MSG_TYPE_WEBTRANSPORT_UPGRADE_ACK
    );
    assert!(claim.owns(&peers["browser"]));
    owner.work.insert(
        Arc::from("browser"),
        Work {
            identity,
            epoch: 0,
            task: None,
            retirements: owner.retirements.clone(),
            bindings: vec![binding],
        },
    );
    owner.invalidate(&peers);
    assert_eq!(owner.adopted.len(), 1);
    assert!(
        !claim.accepts("::1".parse().unwrap()),
        "old epoch admits no new connection"
    );
    write_record(&mut streams[1].0, b"input-after-invalidation").await;
    let input = incoming.recv().await.unwrap();
    assert_eq!(input.payload.as_ref(), b"input-after-invalidation");
    assert_eq!(input.channel_id, CHANNEL_PTY);
    assert_eq!(ownership[input.peer_node_id.as_ref()].as_ref(), "browser");
    super::super::send_to_peer(
        &state,
        "browser",
        CHANNEL_PTY,
        b"output-after-invalidation".to_vec(),
    )
    .await;
    assert_eq!(
        read_record(&mut streams[1].1).await,
        b"output-after-invalidation"
    );
    owner.shutdown().await;
    assert!(
        peers["browser"]
            .direct_session
            .as_ref()
            .unwrap()
            .connection()
            .unwrap()
            .is_closed()
    );
}

#[tokio::test]
async fn ipv6_tftp_binding_authenticates_and_keeps_the_exact_winner_across_invalidation() {
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        ipv6_binding_upgrade(CandidateFlavor::Tftp),
    )
    .await
    .expect("IPv6 helper upgrade completes within the component-test budget");
}

#[tokio::test]
async fn ipv6_sip_binding_authenticates_and_keeps_the_exact_winner_across_invalidation() {
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        ipv6_binding_upgrade(CandidateFlavor::Sip),
    )
    .await
    .expect("IPv6 helper upgrade completes within the component-test budget");
}

#[expect(
    clippy::too_many_lines,
    reason = "one bounded physical experiment owns listener preparation, authenticated upgrade and shutdown"
)]
#[tokio::test]
#[ignore = "requires an owned router and external-path browser; IPv4 also needs a fresh STUN ticket"]
async fn physical_router_admission_and_session_key_upgrade() {
    let config_path = std::env::var("MERKUR_ROUTER_TEST_CONFIG").unwrap();
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
    let browser: IpAddr = config["browser"].as_str().unwrap().parse().unwrap();
    assert!(super::super::side_channel::is_globally_routable(&browser));
    let path = paths(browser)
        .into_iter()
        .find(|path| Some(path.name.as_str()) == config["interface"].as_str())
        .unwrap();
    let credential = if browser.is_ipv4() {
        let secret = URL_SAFE_NO_PAD
            .decode(config["secret"].as_str().unwrap())
            .unwrap();
        stun::StunCredential {
            servers: Arc::new(
                config["servers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap().into())
                    .collect(),
            ),
            ticket: Arc::new(config["ticket"].as_str().unwrap().into()),
            integrity_key: Arc::new(ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &secret)),
            expires_at: tokio::time::Instant::now() + std::time::Duration::from_secs(90),
        }
        .into()
    } else {
        None
    };
    let (_endpoint, cert, info) = super::super::start_server(0, None).unwrap();
    let hash = cert.cert_hash_base64();
    let state = Arc::new(RwLock::new(WebTransportState::from_server_info(
        cert, &info,
    )));
    let (messages, mut incoming) = mpsc::channel(32);
    let (events, mut disconnected) = mpsc::channel(32);
    let retirements = Retirement::new();
    // Fresh unprepared listener: control for reachability before helper admission.
    let baseline_socket = DiscoverySocket::new(bind(&path, 0).unwrap()).unwrap();
    let baseline_config = wtransport::ServerConfig::builder()
        .with_bind_address(baseline_socket.local_addr().unwrap())
        .build_with_quic_config(info.admission_config.clone());
    let baseline_endpoint =
        wtransport::Endpoint::server_with_socket(baseline_config, baseline_socket.clone()).unwrap();
    let mut baseline = WebTransportServer::spawn(
        baseline_endpoint,
        state.clone(),
        messages.clone(),
        events.clone(),
    );
    let baseline_mapping = candidate_endpoint(&baseline_socket, credential.as_ref(), false)
        .await
        .unwrap();
    let epoch = Arc::new(AtomicU64::new(0));
    let mut peers = PeerMap::new();
    let mut bindings = Vec::new();
    let mut candidates = Vec::new();
    let mut enhancements = futures::stream::FuturesUnordered::new();
    let requested = config["kinds"].as_array().unwrap();
    assert!(!requested.is_empty());
    for (index, value) in requested.iter().enumerate() {
        let name = value.as_str().unwrap();
        let kind = match name {
            "tftp" => CandidateFlavor::Tftp,
            "sip" => CandidateFlavor::Sip,
            _ => panic!("unsupported physical test mechanism"),
        };
        let id = format!("browser-{name}-{index}");
        let mut peer = super::tests::peer();
        peer.peer_id = Arc::from(id.as_str());
        peer.browser_address = Some(browser);
        let mut upgrade_secret = [0; 32];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut upgrade_secret)
            .unwrap();
        peer.upgrade_secret = Some(upgrade_secret);
        let claim = Claim::new(
            Identity {
                peer: peer.peer_id.clone(),
                session: peer.signal_session_id.clone(),
                rebind: 0,
                manifest: 1,
                browser,
            },
            epoch.clone(),
            0,
        );
        let started = std::time::Instant::now();
        let preparation = prepare_binding(
            &state,
            &info.admission_config,
            credential.as_ref(),
            &path,
            kind,
            claim,
            messages.clone(),
            events.clone(),
            retirements.clone(),
        );
        let (mut binding, candidate) = if let Some(gate) = config["offerGate"].as_str() {
            let listener = Arc::new(tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap());
            OFFER_GATE.scope((gate.into(), listener), preparation).await
        } else {
            preparation.await
        }
        .unwrap();
        let requested_candidate = candidate.clone();
        if let Some(enhancement) = binding.enhancement.take() {
            enhancements.push(async move { (index, enhancement.await) }.boxed());
        }
        candidates.push(serde_json::json!({ "candidate": candidate, "requestedCandidate": requested_candidate, "preparationMs": started.elapsed().as_secs_f64() * 1000.0, "browserId": id, "upgradeSecret": URL_SAFE_NO_PAD.encode(upgrade_secret) }));
        bindings.push(binding);
        peers.insert(peer.peer_id.clone(), peer);
    }
    let stop = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let output = config["output"].as_str().unwrap();
    let publish = |candidates: &[serde_json::Value], pending: bool| {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "certHash": hash, "baseline": baseline_mapping, "candidates": candidates, "sessionId": "session", "daemonId": "router-test-daemon",
            "stop": stop.local_addr().unwrap().port(), "admission_pending": pending,
        })).unwrap();
        let temporary = format!("{output}.tmp");
        std::fs::write(&temporary, bytes).unwrap();
        std::fs::rename(temporary, output).unwrap();
    };
    publish(&candidates, !enhancements.is_empty());
    let identity = Some(
        crate::auth::DaemonIdentity::new(&URL_SAFE_NO_PAD.encode([0x33; 32]), "router-test-daemon")
            .unwrap(),
    );
    let mut pending = HashMap::new();
    let mut ownership = HashMap::new();
    let started = std::time::Instant::now();
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(90));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => panic!("physical browser check exceeded its 90 second stop condition"),
            _ = stop.accept() => break,
            Some((index, candidate)) = enhancements.next(), if !enhancements.is_empty() => {
                if let Some(candidate) = candidate { candidates[index]["candidate"] = candidate; }
                candidates[index]["observationMs"] = (started.elapsed().as_secs_f64() * 1000.0).into();
                publish(&candidates, !enhancements.is_empty());
            }
            Some(_event) = disconnected.recv() => {},
            Some(message) = incoming.recv() => {
                let now = started.elapsed().as_secs_f64() * 1000.0;
                match ClientSignal::parse(&message.payload) {
                    Some(ClientSignal::WebtransportUpgradeInit(init)) => {
                        crate::session::wt_upgrade_flow::handle_wt_upgrade_init(&message.peer_node_id, &init, &Some(state.clone()), &identity, &peers, &mut pending, now).await;
                    }
                    Some(ClientSignal::WebtransportUpgradeProof(proof)) => {
                        crate::session::wt_upgrade_flow::handle_wt_upgrade_proof(&message.peer_node_id, &proof, &Some(state.clone()), &identity, &mut peers, &mut ownership, &mut pending, now).await;
                    }
                    _ => {
                        let peer = ownership.get(message.peer_node_id.as_ref()).expect("payload belongs to a session-key-authenticated connection");
                        assert!(peers[peer].paths.webtransport.available);
                        super::super::send_to_peer(&state, peer, message.channel_id, message.payload.to_vec()).await;
                    }
                }
            }
        }
    }
    assert_eq!(
        ownership.len(),
        config["expectedConnections"]
            .as_u64()
            .map_or(bindings.len(), |count| usize::try_from(count).unwrap()),
        "every requested binding authenticated"
    );
    for binding in &bindings {
        if ownership
            .values()
            .any(|peer| peer.as_ref() == binding.claim.identity.peer.as_ref())
        {
            assert!(binding.claim.owns(&peers[&binding.claim.identity.peer]));
        } else {
            assert_eq!(config["expectedConnections"].as_u64(), Some(0));
        }
    }
    drop(enhancements);
    drop(bindings);
    drop(baseline.shutdown().await);
    retirements.shutdown().await;
}
