//! Scoped physical socket/upgrade check. The fixture supplies an established
//! peer and key; initial capability/bootstrap and terminal continuity are tested
//! by the full session harness, not by this component check.
use super::*;
use wtransport::quinn::AsyncUdpSocket;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use merkur_wire::signaling::ClientSignal;

#[expect(
    clippy::too_many_lines,
    reason = "one bounded physical experiment owns listener preparation, authenticated upgrade and shutdown"
)]
#[tokio::test]
#[ignore = "requires an owned router, fresh STUN ticket and an external-path browser"]
async fn physical_router_admission_and_session_key_upgrade() {
    let config_path = std::env::var("MERKUR_ROUTER_TEST_CONFIG").unwrap();
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
    let browser: Ipv4Addr = config["browser"].as_str().unwrap().parse().unwrap();
    assert!(super::super::side_channel::is_globally_routable(
        &IpAddr::V4(browser)
    ));
    let path = paths()
        .into_iter()
        .find(|path| Some(path.name.as_str()) == config["interface"].as_str())
        .unwrap();
    let secret = URL_SAFE_NO_PAD
        .decode(config["secret"].as_str().unwrap())
        .unwrap();
    let credential = stun::StunCredential {
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
    let baseline_mapping = stun::admission_mapping(&baseline_socket, &credential, false)
        .await
        .unwrap();
    let epoch = Arc::new(AtomicU64::new(0));
    let mut peers = PeerMap::new();
    let mut bindings = Vec::new();
    let mut candidates = Vec::new();
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
        peer.browser_address = Some(IpAddr::V4(browser));
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
        let (binding, candidate) = prepare_binding(
            &state,
            &info.admission_config,
            &credential,
            &path,
            kind,
            claim,
            messages.clone(),
            events.clone(),
            retirements.clone(),
        )
        .await
        .unwrap();
        candidates.push(serde_json::json!({ "candidate": candidate, "browserId": id, "upgradeSecret": URL_SAFE_NO_PAD.encode(upgrade_secret) }));
        bindings.push(binding);
        peers.insert(peer.peer_id.clone(), peer);
    }
    let stop = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let output = config["output"].as_str().unwrap();
    std::fs::write(output, serde_json::to_vec(&serde_json::json!({
        "certHash": hash, "baseline": baseline_mapping, "candidates": candidates, "sessionId": "session", "daemonId": "router-test-daemon",
        "stop": stop.local_addr().unwrap().port(),
    })).unwrap()).unwrap();
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
        bindings.len(),
        "every requested binding authenticated"
    );
    for binding in &bindings {
        assert!(binding.claim.owns(&peers[&binding.claim.identity.peer]));
    }
    drop(bindings);
    drop(baseline.shutdown().await);
    retirements.shutdown().await;
}
