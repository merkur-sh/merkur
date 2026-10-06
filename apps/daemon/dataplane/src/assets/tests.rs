use super::*;

#[test]
fn request_body_matches_browser_codec_and_rejects_invalid_ranges() {
    let mut body = [0; 100];
    body[1] = 7;
    body[7] = 3;
    body[8..16].copy_from_slice(&[0, 0, 1, 0, 0, 0, 2, 0]);
    body[23] = 9;
    body[24..56].fill(7);
    body[56..88].fill(8);
    body[88..].copy_from_slice(&[0, 0, 64, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    let request = Request::decode(&body).unwrap();
    assert_eq!((request.x, request.y, request.id), (256, 512, 9));
    assert_eq!(request.level, 7);
    assert_eq!(request.frame, 3);
    assert!(!request.manifest);
    assert_eq!(request.source, [7; 32]);
    assert_eq!(*request.range.unwrap().object(), [8; 32]);
    assert!(Request::decode(&body[..56]).unwrap().range.is_none());
    body[1] = 15;
    assert!(Request::decode(&body).is_none());
    body[1] = 7;
    for length in 0..body.len() {
        if length != 56 {
            assert!(Request::decode(&body[..length]).is_none());
        }
    }
    body[99] = 2;
    assert!(Request::decode(&body).is_none());
    body[99] = 1;
    body[23] = 0;
    assert!(Request::decode(&body).is_none());
}

/// The completion wake is process-wide and wakes one waiter. Tests that wait
/// on it take turns, so none consumes another's wake.
static WAKE_OWNER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn panic_completes_request_and_wakes_owner() {
    let _owner = WAKE_OWNER.lock().await;
    let (sender, mut result) = oneshot::channel();
    let task = tokio::spawn(async move {
        let _completion = Completion(Some(sender));
        panic!("injected asset failure");
    });
    assert!(task.await.unwrap_err().is_panic());
    COMPLETED.notified().await;
    assert_eq!(result.try_recv(), Ok(Outcome::Refused));
}

const PEER: &str = "graphics-peer";

fn request_body(id: u64, root: [u8; 32]) -> [u8; 56] {
    let mut body = [0; 56];
    body[16..24].copy_from_slice(&id.to_be_bytes());
    body[24..56].copy_from_slice(&root);
    body
}

fn active(requests: &mut Requests, index: usize, id: u64) -> Completion {
    let (cancel, _) = oneshot::channel();
    let (sender, result) = oneshot::channel();
    requests.slots[index] = Some(Slot {
        request: Request::decode(&request_body(id, [7; 32])).unwrap(),
        via: PeerTransport::Edge,
        stage: Stage::Active {
            cancel: Some(cancel),
            result,
        },
    });
    Completion(Some(sender))
}

#[test]
fn cancellation_retains_slot_until_task_retires() {
    let mut requests = Requests::new();
    let completion = active(&mut requests, 0, 1);
    assert_eq!(
        requests.cancel(1, PeerTransport::WebTransport),
        Cancel::Active
    );
    assert!(requests.completed().is_none());
    assert!(requests.slots[0].is_some());
    completion.publish(Outcome::Cancelled);
    let (id, via, owed) = requests.completed().unwrap();
    assert_eq!(id, 1);
    assert_eq!(via, PeerTransport::WebTransport);
    assert!(owed, "cancellation acknowledges physical retirement");
    assert!(requests.slots[0].is_none());
}

#[test]
fn a_retired_source_keeps_its_request_id_parked() {
    let mut requests = Requests::new();
    active(&mut requests, 3, 9).publish(Outcome::Retired);
    assert!(requests.completed().is_none(), "nothing is freed or owed");
    let slot = requests.slots[3].as_ref().unwrap();
    assert_eq!((slot.request.id, slot.via), (9, PeerTransport::Edge));
    assert!(matches!(slot.stage, Stage::Parked));
    assert!(requests.parked());
    // A parked request owns no task: its cancel frees it and is answered now.
    assert_eq!(requests.cancel(9, PeerTransport::Edge), Cancel::Parked);
    assert!(requests.slots[3].is_none());
    assert_eq!(requests.cancel(9, PeerTransport::Edge), Cancel::Unknown);
}

#[test]
fn only_refusals_and_acknowledged_cancels_owe_a_reply() {
    for (outcome, cancelled, owed) in [
        (Outcome::Delivered, false, false),
        (Outcome::Carrier, false, false),
        (Outcome::Refused, false, true),
        (Outcome::Carrier, true, true),
        (Outcome::Retired, true, true),
    ] {
        let mut requests = Requests::new();
        let completion = active(&mut requests, 0, 4);
        if cancelled {
            requests.cancel(4, PeerTransport::Edge);
        }
        completion.publish(outcome);
        assert_eq!(
            requests.completed(),
            Some((4, PeerTransport::Edge, owed)),
            "{outcome:?} cancelled={cancelled}"
        );
        assert!(requests.slots[0].is_none());
    }
}

fn noise_pair() -> (crate::e2e::NoiseTransport, crate::e2e::NoiseTransport) {
    let psk = [7u8; 32];
    let prologue = crate::e2e::derive_prologue("session", "daemon", &[0x42; 64]);
    let (browser_static, _) = crate::e2e::generate_static_keypair().unwrap();
    let (daemon_static, _) = crate::e2e::generate_static_keypair().unwrap();
    let mut browser =
        crate::e2e::NoiseHandshake::new_initiator(&browser_static, &psk, &prologue).unwrap();
    let mut daemon =
        crate::e2e::NoiseHandshake::new_responder(&daemon_static, &psk, &prologue).unwrap();
    daemon
        .read_message(&browser.write_message(b"").unwrap())
        .unwrap();
    browser
        .read_message(&daemon.write_message(b"").unwrap())
        .unwrap();
    daemon
        .read_message(&browser.write_message(b"").unwrap())
        .unwrap();
    (
        daemon.into_transport().unwrap(),
        browser.into_transport().unwrap(),
    )
}

/// An authenticated peer and the browser half of its Noise session.
fn peer() -> (PeerDisplayState, crate::e2e::NoiseTransport) {
    let (daemon, browser) = noise_pair();
    let mut peer = PeerDisplayState::new(Arc::from(PEER), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(daemon);
    (peer, browser)
}

fn message(via: PeerTransport) -> PeerMessage {
    PeerMessage {
        input_permit: None,
        peer_node_id: Arc::from(PEER),
        channel_id: CHANNEL_CTRL,
        payload: bytes::Bytes::new(),
        via_transport: via,
        delivery: DeliveryMode::Stream,
        connection_id: 0,
        edge_ingress: None,
    }
}

fn parked(peer: &PeerDisplayState) -> Vec<u64> {
    peer.graphics_requests
        .iter()
        .flat_map(|requests| requests.slots.iter().flatten())
        .filter(|slot| matches!(slot.stage, Stage::Parked))
        .map(|slot| slot.request.id)
        .collect()
}

fn replies(peer: &PeerDisplayState) -> Vec<u64> {
    peer.graphics_requests
        .iter()
        .flat_map(|requests| requests.replies.iter().flatten())
        .map(|reply| reply.id)
        .collect()
}

/// Every request id holding a slot, parked or served.
fn held(peer: &PeerDisplayState) -> Vec<u64> {
    peer.graphics_requests
        .iter()
        .flat_map(|requests| requests.slots.iter().flatten())
        .map(|slot| slot.request.id)
        .collect()
}

fn terminal() -> TerminalState {
    let (tx, _) = crossbeam_channel::unbounded();
    TerminalState::new(80, 3, tx)
}

#[tokio::test]
async fn a_browser_window_waits_for_physical_retirement_without_refusal_or_reordering() {
    let terminal = terminal();
    let (mut peer, _) = peer();
    let msg = message(PeerTransport::Edge);
    let count = CONTENT_MAX_TRANSFERS as usize;
    let mut completions = Vec::new();
    for index in 0..count {
        completions.push(active(requests(&mut peer), index, index as u64 + 1));
    }
    for id in 33..=64 {
        handle(
            &msg,
            MSG_TYPE_GRAPHICS_REQUEST,
            &request_body(id, [7; 32]),
            &mut peer,
            &terminal,
            0.0,
        );
    }
    assert_eq!(requests(&mut peer).waiting.len(), count);
    assert_eq!(held(&peer).len(), count);
    assert!(replies(&peer).is_empty());
    // Beyond the browser's complete next window is not legitimate pressure.
    handle(
        &msg,
        MSG_TYPE_GRAPHICS_REQUEST,
        &request_body(65, [7; 32]),
        &mut peer,
        &terminal,
        0.0,
    );
    assert_eq!(replies(&peer), [65]);
    handle(
        &msg,
        MSG_TYPE_GRAPHICS_CANCEL,
        &35u64.to_be_bytes(),
        &mut peer,
        &terminal,
        0.0,
    );
    assert_eq!(requests(&mut peer).waiting.len(), count - 1);
    // A reliable replay cannot restore an id its cancellation already retired.
    handle(
        &msg,
        MSG_TYPE_GRAPHICS_REQUEST,
        &request_body(35, [7; 32]),
        &mut peer,
        &terminal,
        0.0,
    );
    assert_eq!(requests(&mut peer).waiting.len(), count - 1);
    // A new arrival observes a finished task before the owner's next reap.
    // That vacancy belongs to the oldest waiting request, not the new arrival.
    completions.pop().unwrap().publish(Outcome::Delivered);
    handle(
        &msg,
        MSG_TYPE_GRAPHICS_REQUEST,
        &request_body(66, [7; 32]),
        &mut peer,
        &terminal,
        0.0,
    );
    assert_eq!(parked(&peer), [33]);
    assert_eq!(requests(&mut peer).waiting.back().unwrap().0.id, 66);
    completions.reverse();
    for completion in completions {
        completion.publish(Outcome::Delivered);
    }
    reap_peer(&mut peer, &terminal, 0.0);
    assert!(requests(&mut peer).waiting.is_empty());
    let mut parked_ids = parked(&peer);
    parked_ids.sort_unstable();
    assert_eq!(
        parked_ids,
        (33..=64)
            .filter(|id| *id != 35)
            .chain([66])
            .collect::<Vec<_>>()
    );
    assert_eq!(replies(&peer), [65, 35]);
}

#[tokio::test]
async fn requests_for_an_absent_root_park_within_the_window_and_each_cancel_is_answered() {
    let terminal = terminal();
    let (mut peer, _) = peer();
    let msg = message(PeerTransport::Edge);
    for id in 1..=u64::from(CONTENT_MAX_TRANSFERS) {
        let body = request_body(id, [7; 32]);
        handle(
            &msg,
            MSG_TYPE_GRAPHICS_REQUEST,
            &body,
            &mut peer,
            &terminal,
            0.0,
        );
    }
    assert_eq!(parked(&peer).len(), CONTENT_MAX_TRANSFERS as usize);
    assert!(replies(&peer).is_empty(), "an absent root is not a refusal");
    // Parked requests hold the browser's window, so one more is refused.
    let body = request_body(33, [7; 32]);
    handle(
        &msg,
        MSG_TYPE_GRAPHICS_REQUEST,
        &body,
        &mut peer,
        &terminal,
        0.0,
    );
    assert_eq!(replies(&peer), [33]);
    // A parked request's cancel frees its slot, and each cancel is answered;
    // a repeated one coalesces into the pending reply.
    for _ in 0..2 {
        let id = 5u64.to_be_bytes();
        handle(
            &msg,
            MSG_TYPE_GRAPHICS_CANCEL,
            &id,
            &mut peer,
            &terminal,
            0.0,
        );
    }
    assert_eq!(parked(&peer).len(), CONTENT_MAX_TRANSFERS as usize - 1);
    assert!(!parked(&peer).contains(&5));
    assert_eq!(replies(&peer), [33, 5]);
    let body = request_body(34, [7; 32]);
    handle(
        &msg,
        MSG_TYPE_GRAPHICS_REQUEST,
        &body,
        &mut peer,
        &terminal,
        0.0,
    );
    assert!(parked(&peer).contains(&34));
    assert_eq!(replies(&peer), [33, 5]);
}

struct Loopback {
    daemon: Arc<Connection>,
    browser: Connection,
    _endpoints: (
        wtransport::Endpoint<wtransport::endpoint::endpoint_side::Server>,
        wtransport::Endpoint<wtransport::endpoint::endpoint_side::Client>,
    ),
}

async fn loopback() -> Loopback {
    loopback_with(None, None).await
}

/// A loopback carrier whose browser half grants each stream at most `window`
/// bytes of credit. With `held`, the browser's datagrams reach the daemon through
/// a relay that queues them while `held` is set, withholding every
/// acknowledgement without touching what the daemon sends.
async fn loopback_with(window: Option<u32>, held: Option<watch::Receiver<bool>>) -> Loopback {
    let (config, cert) = crate::webtransport::build_server_config(0).unwrap();
    let server = wtransport::Endpoint::server(config).unwrap();
    let mut port = server.local_addr().unwrap().port();
    if let Some(held) = held {
        port = relay(port, held).await;
    }
    let url = format!("https://127.0.0.1:{port}");
    let mut config = wtransport::ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(cert.cert_hash)])
        .build();
    if let Some(window) = window {
        let mut transport = wtransport::quinn::TransportConfig::default();
        transport.stream_receive_window(wtransport::quinn::VarInt::from_u32(window));
        config
            .quic_config_mut()
            .transport_config(Arc::new(transport));
    }
    let client = wtransport::Endpoint::client(config).unwrap();
    let (daemon, browser) = tokio::join!(
        async { server.accept().await.await.unwrap().accept().await.unwrap() },
        client.connect(&url)
    );
    Loopback {
        daemon: Arc::new(daemon),
        browser: browser.unwrap(),
        _endpoints: (server, client),
    }
}

/// Forward datagrams between a browser and the daemon listening on `daemon`,
/// queueing the browser's while `held` is set. Returns the relay's port.
async fn relay(daemon: u16, mut held: watch::Receiver<bool>) -> u16 {
    let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = socket.local_addr().unwrap().port();
    let daemon = std::net::SocketAddr::from(([127, 0, 0, 1], daemon));
    tokio::spawn(async move {
        let mut browser = None;
        let mut withheld = Vec::new();
        let mut datagram = vec![0; 65_536];
        loop {
            tokio::select! {
                received = socket.recv_from(&mut datagram) => {
                    let Ok((len, from)) = received else { return };
                    if from.port() == daemon.port() {
                        if let Some(browser) = browser {
                            let _ = socket.send_to(&datagram[..len], browser).await;
                        }
                        continue;
                    }
                    browser = Some(from);
                    if *held.borrow() {
                        withheld.push(datagram[..len].to_vec());
                    } else {
                        let _ = socket.send_to(&datagram[..len], daemon).await;
                    }
                }
                changed = held.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    if !*held.borrow_and_update() {
                        for packet in withheld.drain(..) {
                            let _ = socket.send_to(&packet, daemon).await;
                        }
                    }
                }
            }
        }
    });
    port
}

fn pairing(
    link: &Loopback,
    lane: crate::network::protocol::EdgeLane,
    state: CounterpartState,
) -> (
    Arc<crate::edge_tunnel::EdgeTunnel>,
    watch::Sender<CounterpartState>,
    crate::edge_tunnel::TestReliableLanes,
) {
    let (report, counterpart) = watch::channel(state);
    let (tunnel, lanes) = crate::edge_tunnel::EdgeTunnel::new_test_pairing(
        Arc::clone(&link.daemon),
        lane,
        counterpart,
    );
    (Arc::new(tunnel), report, lanes)
}

fn attached(attachment_id: u64) -> CounterpartState {
    CounterpartState::Attached { attachment_id }
}

#[tokio::test]
async fn edge_content_rides_confirmed_bulk_only_while_its_browser_half_is_paired() {
    use crate::network::protocol::EdgeLane;
    let interactive_link = loopback().await;
    let bulk_link = loopback().await;
    let (interactive, interactive_report, _) =
        pairing(&interactive_link, EdgeLane::Interactive, attached(1));
    let (bulk, bulk_report, _) = pairing(&bulk_link, EdgeLane::Bulk, attached(2));
    let (mut peer, _) = peer();
    peer.edge_tunnel = Some(interactive);
    peer.edge_tunnel_bulk = Some(bulk);
    peer.bulk_delivery_confirmed = true;
    fn selected(peer: &PeerDisplayState) -> Option<(usize, usize)> {
        carrier(peer, PeerTransport::Edge)
            .map(|(carrier, group)| (carrier.stable_id(), group.stable_id()))
    }
    let interactive_id = interactive_link.daemon.stable_id();
    let bulk_id = bulk_link.daemon.stable_id();
    assert_eq!(selected(&peer), Some((bulk_id, interactive_id)));
    // The browser's bulk half detached; its confirmation outlives it until the
    // next claim, but the edge would drop content sent there.
    bulk_report.send_replace(CounterpartState::Detached {
        rebind_window_remaining_ms: 5_000,
    });
    assert_eq!(selected(&peer), Some((interactive_id, interactive_id)));
    bulk_report.send_replace(attached(3));
    assert_eq!(selected(&peer), Some((bulk_id, interactive_id)));
    // Without an interactive pairing there is no carrier at all.
    interactive_report.send_replace(CounterpartState::Detached {
        rebind_window_remaining_ms: 5_000,
    });
    assert_eq!(selected(&peer), None);
    interactive_report.send_replace(attached(4));
    bulk_link.daemon.close(VarInt::from_u32(0), b"retired");
    assert_eq!(selected(&peer), Some((interactive_id, interactive_id)));
}

/// A direct response rides the session the upgrade installed on the peer,
/// found without the registry, and a closed one is no carrier, as a registry
/// that dropped it would have none.
#[tokio::test]
async fn direct_content_rides_the_peers_own_open_session() {
    let link = loopback().await;
    let (mut peer, _) = peer();
    assert!(carrier(&peer, PeerTransport::WebTransport).is_none());
    peer.direct_session = Some(crate::webtransport::DirectSession::from_connection(
        Arc::clone(&link.daemon),
    ));
    let (selected, group) =
        carrier(&peer, PeerTransport::WebTransport).expect("the admitted session");
    assert_eq!(selected.stable_id(), link.daemon.stable_id());
    assert_eq!(group.stable_id(), link.daemon.stable_id());
    link.daemon.close(VarInt::from_u32(0), b"retired");
    assert!(carrier(&peer, PeerTransport::WebTransport).is_none());
}

/// Reap until `done` holds. The completion wake is process-wide, so a wake
/// may belong to another test; reaping again is harmless.
async fn settle(
    peers: &mut PeerMap,
    terminal: &TerminalState,
    mut done: impl FnMut(&mut PeerMap) -> bool,
) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            reap(peers, terminal, 0.0);
            if done(peers) {
                return;
            }
            COMPLETED.notified().await;
        }
    })
    .await
    .expect("graphics owner settled");
}

fn unavailable_id(browser: &mut crate::e2e::NoiseTransport, sealed: &[u8]) -> u64 {
    let lane = crate::e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let frame = browser.open_stream(lane, sealed).unwrap();
    let (kind, body) = decode_proto_frame(&frame).unwrap();
    assert_eq!(kind, MSG_TYPE_GRAPHICS_UNAVAILABLE);
    u64::from_be_bytes(body.try_into().unwrap())
}

#[tokio::test]
async fn a_reply_waits_for_its_pairing_and_publishes_once_after_the_carrier_retires() {
    use crate::network::protocol::EdgeLane;
    let _owner = WAKE_OWNER.lock().await;
    let link = loopback().await;
    let (tunnel, report, mut lanes) =
        pairing(&link, EdgeLane::Interactive, CounterpartState::Pending);
    let terminal = terminal();
    let (mut peer, mut browser) = peer();
    peer.edge_tunnel = Some(tunnel);
    let mut peers = PeerMap::new();
    peers.insert(Arc::from(PEER), peer);
    let peer = peers.get_mut(PEER).unwrap();
    // A cancel for an unknown id arrives before the edge reports its pairing.
    replies::enqueue(peer, 7, PeerTransport::Edge);
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    reap(&mut peers, &terminal, 0.0);
    assert_eq!(lanes.try_recv(CHANNEL_CTRL), None);
    assert_eq!(replies(&peers[PEER]), [7]);
    // The pairing lands and the reply reserves capacity on it, but that
    // pairing is replaced before the owner publishes.
    report.send_replace(attached(1));
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    report.send_replace(attached(2));
    settle(&mut peers, &terminal, |peers| {
        replies(&peers[PEER]).is_empty()
    })
    .await;
    let sealed = lanes
        .try_recv(CHANNEL_CTRL)
        .expect("the reply was published");
    assert_eq!(unavailable_id(&mut browser, &sealed), 7);
    assert_eq!(lanes.try_recv(CHANNEL_CTRL), None, "published exactly once");
}

#[tokio::test]
async fn a_request_its_cancel_overtook_is_never_admitted() {
    use crate::network::protocol::EdgeLane;
    let _owner = WAKE_OWNER.lock().await;
    let link = loopback().await;
    let (tunnel, _report, mut lanes) = pairing(&link, EdgeLane::Interactive, attached(1));
    let terminal = terminal();
    let (mut peer, mut browser) = peer();
    peer.edge_tunnel = Some(tunnel);
    let mut peers = PeerMap::new();
    peers.insert(Arc::from(PEER), peer);
    fn send(
        peers: &mut PeerMap,
        terminal: &TerminalState,
        via: PeerTransport,
        kind: u8,
        body: &[u8],
    ) {
        let peer = peers.get_mut(PEER).unwrap();
        handle(&message(via), kind, body, peer, terminal, 0.0);
    }
    // Request 5 left on one carrier and its cancel on a faster one. The cancel
    // arrives first, finds nothing, and its answer is published.
    let cancel = 5u64.to_be_bytes();
    send(
        &mut peers,
        &terminal,
        PeerTransport::Edge,
        MSG_TYPE_GRAPHICS_CANCEL,
        &cancel,
    );
    settle(&mut peers, &terminal, |peers| {
        replies(&peers[PEER]).is_empty()
    })
    .await;
    let sealed = lanes
        .try_recv(CHANNEL_CTRL)
        .expect("the cancel is answered");
    assert_eq!(unavailable_id(&mut browser, &sealed), 5);
    // The request arrives late, for a root that is gone. The browser has
    // retired its id, so nothing would ever cancel a parked copy.
    let late = request_body(5, [7; 32]);
    send(
        &mut peers,
        &terminal,
        PeerTransport::WebTransport,
        MSG_TYPE_GRAPHICS_REQUEST,
        &late,
    );
    assert_eq!(
        held(&peers[PEER]),
        [0u64; 0],
        "the answered cancel retired the id"
    );
    assert_eq!(replies(&peers[PEER]), [0u64; 0], "and nothing more is owed");
    // Requests that overtake each other are each admitted, once.
    for id in [9u64, 8, 9] {
        let body = request_body(id, [7; 32]);
        send(
            &mut peers,
            &terminal,
            PeerTransport::WebTransport,
            MSG_TYPE_GRAPHICS_REQUEST,
            &body,
        );
    }
    assert_eq!(parked(&peers[PEER]), [9, 8]);
    assert_eq!(lanes.try_recv(CHANNEL_CTRL), None);
}

/// Real image-helper coverage for requests whose source root leaves and
/// returns. The helper decodes the uploads; the direct carrier is a live
/// loopback connection read by the browser half of the test's Noise session.
mod real_helper {
    use super::*;
    use merkur_graphics::scene::SceneContent;
    use tokio::io::AsyncReadExt;

    struct Harness {
        _owner: tokio::sync::MutexGuard<'static, ()>,
        terminal: TerminalState,
        peers: PeerMap,
        browser: crate::e2e::NoiseTransport,
        link: Loopback,
        ctrl: tokio::sync::mpsc::Receiver<crate::network::peer::ReliablePayload>,
    }

    async fn harness() -> Harness {
        harness_on(loopback()).await
    }

    /// The direct carrier is `link`, connected once the process-wide wake is ours.
    async fn harness_on(link: impl std::future::Future<Output = Loopback>) -> Harness {
        let owner = WAKE_OWNER.lock().await;
        let mut terminal = super::terminal();
        terminal.use_built_image_worker();
        let (mut peer, browser) = super::peer();
        let link = link.await;
        // As the upgrade admits it: the session and its reliable lanes, installed
        // on the peer.
        let (ctrl_tx, ctrl) = tokio::sync::mpsc::channel(64);
        let (pty, _) = tokio::sync::mpsc::channel(1);
        let (display_commit, _) = tokio::sync::mpsc::channel(1);
        peer.direct_session = Some(crate::webtransport::DirectSession::new(
            Arc::clone(&link.daemon),
            crate::network::peer::ChannelSenders {
                ctrl: ctrl_tx,
                pty,
                display_commit,
                signaling: None,
            },
        ));
        let mut peers = PeerMap::new();
        peers.insert(Arc::from(PEER), peer);
        Harness {
            _owner: owner,
            terminal,
            peers,
            browser,
            link,
            ctrl,
        }
    }

    impl Harness {
        async fn apply(&mut self, bytes: &[u8]) {
            let wake = self.terminal.graphics_wake();
            let mut accepted = self.terminal.apply_bytes(bytes);
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                while self.terminal.graphics_pending() {
                    wake.notified().await;
                    accepted += self.terminal.apply_bytes(&bytes[accepted..]);
                }
            })
            .await
            .expect("graphics owner resumed on completion");
            assert_eq!(accepted, bytes.len());
            if self.terminal.take_published_roots() {
                unpark(&mut self.peers, &self.terminal, 0.0);
            }
        }

        fn root(&self, id: u32) -> [u8; 32] {
            self.terminal
                .graphics_image(id)
                .expect("live image")
                .content
                .descriptor()
                .root
        }

        fn request(&mut self, id: u64, root: [u8; 32]) {
            self.request_on(PeerTransport::WebTransport, id, root);
        }

        fn request_on(&mut self, via: PeerTransport, id: u64, root: [u8; 32]) {
            let body = request_body(id, root);
            let msg = message(via);
            let peer = self.peers.get_mut(PEER).unwrap();
            let terminal = &self.terminal;
            handle(&msg, MSG_TYPE_GRAPHICS_REQUEST, &body, peer, terminal, 0.0);
        }

        fn peer(&self) -> &PeerDisplayState {
            &self.peers[PEER]
        }

        async fn settle(&mut self, done: impl FnMut(&mut PeerMap) -> bool) {
            super::settle(&mut self.peers, &self.terminal, done).await;
        }

        /// Every UNAVAILABLE published so far.
        fn unavailable(&mut self) -> Vec<u64> {
            let mut ids = Vec::new();
            while let Ok(payload) = self.ctrl.try_recv() {
                ids.push(unavailable_id(&mut self.browser, payload.as_slice()));
            }
            ids
        }

        /// The next response stream, reaping as the owner loop does meanwhile.
        async fn stream(&mut self) -> wtransport::RecvStream {
            let Self {
                link,
                peers,
                terminal,
                ..
            } = self;
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    tokio::select! {
                        stream = link.browser.accept_uni() => return stream.unwrap(),
                        () = COMPLETED.notified() => reap(peers, terminal, 0.0),
                    }
                }
            })
            .await
            .expect("a response stream")
        }

        /// Read the next response stream and open it as the browser does.
        async fn receive(&mut self, request: u64, source: [u8; 32]) -> Received {
            let mut stream = self.stream().await;
            let mut wire = Vec::new();
            let finished = stream.read_to_end(&mut wire).await.is_ok();
            if !finished {
                return Received::Reset;
            }
            assert_eq!(wire[0], CHANNEL_GRAPHICS_CONTENT | 0x80);
            assert_eq!(
                u32::from_be_bytes(wire[1..5].try_into().unwrap()) as usize,
                wire.len() - 5
            );
            let mut expected = merkur_e2e::ContentRequests::default();
            expected
                .whole(
                    request,
                    source,
                    merkur_e2e::CONTENT_MAX_OBJECT_BYTES as u32,
                )
                .unwrap();
            let header = &wire[5..5 + merkur_e2e::CONTENT_HEADER_BYTES];
            let mut receiver = self
                .browser
                .content_receiver(&mut expected, header)
                .expect("an authenticated response for this request");
            let descriptor = receiver.descriptor();
            let mut plaintext = Vec::new();
            let mut offset = 5 + merkur_e2e::CONTENT_HEADER_BYTES;
            let mut out = vec![0; CONTENT_CHUNK_BYTES + 16];
            while offset < wire.len() {
                let remaining = descriptor.object_bytes() as usize - plaintext.len();
                let record = remaining.min(CONTENT_CHUNK_BYTES) + CONTENT_CHUNK_OVERHEAD;
                let chunk = receiver
                    .open_chunk(&wire[offset..offset + record], &mut out)
                    .unwrap();
                plaintext.extend_from_slice(&out[..chunk.len]);
                offset += record;
            }
            Received::Tile {
                object: *descriptor.object(),
                bytes: plaintext,
            }
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    enum Received {
        Tile { object: [u8; 32], bytes: Vec<u8> },
        Reset,
    }

    const UPLOAD: &[u8] = b"\x1b_Ga=t,f=24,s=1,v=1,i=5;AAAA\x1b\\";
    const UPLOAD_TWIN: &[u8] = b"\x1b_Ga=t,f=24,s=1,v=1,i=6;AAAA\x1b\\";
    const DELETE: &[u8] = b"\x1b_Ga=d,d=I,i=5\x1b\\";
    const DELETE_TWIN: &[u8] = b"\x1b_Ga=d,d=I,i=6\x1b\\";

    fn sampling_source(h: &Harness, id: u32) -> [u8; 32] {
        h.terminal
            .graphics_image(id)
            .unwrap()
            .content
            .frame_root(0)
            .unwrap()
    }

    #[tokio::test]
    #[ignore = "requires cargo build --locked -p merkur-image-worker; real sandbox integration"]
    async fn a_request_for_an_absent_root_completes_once_it_is_published() {
        let mut h = harness().await;
        h.apply(UPLOAD).await;
        let root = h.root(5);
        let source = sampling_source(&h, 5);
        h.apply(DELETE).await;
        assert!(h.terminal.graphics_source(&root).is_none());
        h.request(1, root);
        assert_eq!(parked(h.peer()), [1]);
        h.apply(UPLOAD).await;
        assert!(parked(h.peer()).is_empty(), "publication unparks it");
        let Received::Tile { object, .. } = h.receive(1, source).await else {
            panic!("the parked request was served");
        };
        assert_ne!(object, [0; 32]);
        h.settle(|peers| {
            peers[PEER]
                .graphics_requests
                .as_ref()
                .is_some_and(|requests| requests.slots.iter().all(Option::is_none))
        })
        .await;
        assert_eq!(h.unavailable(), [0u64; 0]);
        h.terminal.shutdown_graphics().await;
    }

    #[tokio::test]
    #[ignore = "requires cargo build --locked -p merkur-image-worker; real sandbox integration"]
    async fn a_source_replaced_by_identical_content_serves_the_same_request_id() {
        let mut h = harness().await;
        h.apply(UPLOAD).await;
        let root = h.root(5);
        let source = sampling_source(&h, 5);
        // Holding every transfer credit parks the admitted transfer in its
        // credit wait while the replacement retires the content it was
        // admitted to read and publishes identical pixels under the same root.
        let credits = TRANSFER_CREDITS
            .acquire_many(TRANSFERS as u32)
            .await
            .unwrap();
        h.request(2, root);
        h.apply(UPLOAD).await;
        assert!(h.root(5) == root && held(h.peer()) == [2]);
        drop(credits);
        let Received::Tile { .. } = h.receive(2, source).await else {
            panic!("the replacement serves the same request id");
        };
        h.settle(|peers| {
            peers[PEER]
                .graphics_requests
                .as_ref()
                .is_some_and(|requests| requests.slots.iter().all(Option::is_none))
        })
        .await;
        assert_eq!(h.unavailable(), [0u64; 0]);
        h.terminal.shutdown_graphics().await;
    }

    #[tokio::test]
    #[ignore = "requires cargo build --locked -p merkur-image-worker; real sandbox integration"]
    async fn deleting_one_of_two_images_sharing_a_root_serves_from_the_other() {
        let mut h = harness().await;
        h.apply(UPLOAD).await;
        h.apply(UPLOAD_TWIN).await;
        let root = h.root(6);
        assert_eq!(root, h.root(5), "identical pixels share a root");
        let source = sampling_source(&h, 6);
        h.request(3, root);
        // The transfer reads the newest image with the root; deleting it
        // leaves the root live under the other.
        h.apply(DELETE_TWIN).await;
        assert!(h.terminal.graphics_source(&root).is_some());
        let Received::Tile { .. } = h.receive(3, source).await else {
            panic!("the surviving image serves the request");
        };
        h.settle(|peers| {
            peers[PEER]
                .graphics_requests
                .as_ref()
                .is_some_and(|requests| requests.slots.iter().all(Option::is_none))
        })
        .await;
        assert_eq!(h.unavailable(), [0u64; 0]);
        h.terminal.shutdown_graphics().await;
    }

    /// Image `id`, 128x128 of noise: its level-0 tile spans several content chunks.
    fn noise_upload(id: u32) -> Vec<u8> {
        use base64::Engine;
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let pixels: Vec<u8> = (0..128 * 128 * 3)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(pixels);
        let chunks: Vec<_> = encoded
            .as_bytes()
            .chunks(merkur_graphics::command::MAX_CHUNK_BYTES)
            .collect();
        let mut input = Vec::new();
        for (index, chunk) in chunks.iter().enumerate() {
            if index == 0 {
                let control = format!("\x1b_Ga=t,f=24,s=128,v=128,i={id},m=1;");
                input.extend_from_slice(control.as_bytes());
            } else if index + 1 == chunks.len() {
                input.extend_from_slice(b"\x1b_Gm=0;");
            } else {
                input.extend_from_slice(b"\x1b_Gm=1;");
            }
            input.extend_from_slice(chunk);
            input.extend_from_slice(b"\x1b\\");
        }
        input
    }

    #[tokio::test]
    #[ignore = "requires cargo build --locked -p merkur-image-worker; real sandbox integration"]
    async fn a_retirement_before_every_byte_is_queued_resets_the_stream_and_owes_no_refusal() {
        // The browser grants each stream 16 KiB, so the tile's writes wait on
        // the browser while its source retires.
        let mut h = harness_on(loopback_with(Some(16 * 1024), None)).await;
        let upload = noise_upload(5);
        h.apply(&upload).await;
        let root = h.root(5);
        let source = sampling_source(&h, 5);
        h.request(4, root);
        let mut stream = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            h.link.browser.accept_uni(),
        )
        .await
        .expect("a response stream")
        .unwrap();
        let mut first = [0; 1];
        stream.read_exact(&mut first).await.unwrap();
        h.apply(DELETE).await;
        let mut rest = Vec::new();
        assert!(
            stream.read_to_end(&mut rest).await.is_err(),
            "the unfinished stream is reset"
        );
        h.settle(|peers| parked(&peers[PEER]) == [4]).await;
        assert_eq!(
            h.unavailable(),
            [0u64; 0],
            "a retired source is not a refusal"
        );
        // The request keeps its id: the browser's own recovery or a
        // returning root answers it.
        h.apply(&upload).await;
        let Received::Tile { .. } = h.receive(4, source).await else {
            panic!("the parked request was served");
        };
        h.terminal.shutdown_graphics().await;
    }

    #[tokio::test]
    #[ignore = "requires cargo build --locked -p merkur-image-worker; real sandbox integration"]
    async fn a_retirement_after_every_byte_is_queued_is_delivered() {
        let (hold, holding) = watch::channel(false);
        let mut h = harness_on(loopback_with(None, Some(holding))).await;
        h.apply(UPLOAD).await;
        let root = h.root(5);
        let source = sampling_source(&h, 5);
        // Nothing the browser sends reaches the daemon, so FIN stays
        // unacknowledged while the browser reads the whole tile.
        hold.send_replace(true);
        h.request(1, root);
        let Received::Tile { .. } = h.receive(1, source).await else {
            panic!("the browser holds the tile and its FIN");
        };
        // The browser is done with the id, which it will never cancel. The
        // source retires before the daemon learns that; it cannot recall the
        // stream, so the slot must not wait for the root to return.
        h.apply(DELETE).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        hold.send_replace(false);
        h.settle(|peers| held(&peers[PEER]).is_empty()).await;
        assert_eq!(h.unavailable(), [0u64; 0]);
        h.terminal.shutdown_graphics().await;
    }

    #[tokio::test]
    #[ignore = "requires cargo build --locked -p merkur-image-worker; real sandbox integration"]
    async fn a_consumed_window_admits_its_successor_before_fin_acknowledgment() {
        let (hold, holding) = watch::channel(false);
        let mut h = harness_on(loopback_with(None, Some(holding))).await;
        h.apply(UPLOAD).await;
        let root = h.root(5);
        let source = sampling_source(&h, 5);
        hold.send_replace(true);
        for id in 1..=u64::from(CONTENT_MAX_TRANSFERS) {
            h.request(id, root);
            assert!(matches!(h.receive(id, source).await, Received::Tile { .. }));
        }
        // The browser verified all 32 tiles, but no FIN acknowledgment has
        // reached the daemon. Its new request must wait, not become refused.
        h.request(33, root);
        assert_eq!(held(h.peer()).len(), CONTENT_MAX_TRANSFERS as usize);
        assert_eq!(
            h.peer().graphics_requests.as_ref().unwrap().waiting.len(),
            1
        );
        assert!(h.unavailable().is_empty());
        hold.send_replace(false);
        h.settle(|peers| {
            peers[PEER]
                .graphics_requests
                .as_ref()
                .unwrap()
                .waiting
                .is_empty()
        })
        .await;
        assert!(matches!(h.receive(33, source).await, Received::Tile { .. }));
        h.settle(|peers| held(&peers[PEER]).is_empty()).await;
        assert!(h.unavailable().is_empty());
        h.terminal.shutdown_graphics().await;
    }

    #[tokio::test]
    #[ignore = "requires cargo build --locked -p merkur-image-worker; real sandbox integration"]
    async fn a_pairing_report_does_not_withdraw_a_stream_the_edge_forwards() {
        use crate::network::protocol::EdgeLane;
        let mut h = harness().await;
        h.apply(UPLOAD).await;
        let root = h.root(5);
        let source = sampling_source(&h, 5);
        let (tunnel, report, mut lanes) = pairing(&h.link, EdgeLane::Interactive, attached(1));
        h.peers.get_mut(PEER).unwrap().edge_tunnel = Some(tunnel);
        // The transfer waits for a credit while the browser half it was
        // admitted with is replaced. The edge forwards a stream to whichever
        // attachment is paired when it arrives, and the report of that pairing
        // may reach the browser before this request left it: nothing would
        // re-ask a stream withdrawn here.
        let credits = TRANSFER_CREDITS
            .acquire_many(TRANSFERS as u32)
            .await
            .unwrap();
        h.request_on(PeerTransport::Edge, 3, root);
        report.send_replace(attached(2));
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        drop(credits);
        let Received::Tile { .. } = h.receive(3, source).await else {
            panic!("the stream reaches the attachment paired now");
        };
        h.settle(|peers| held(&peers[PEER]).is_empty()).await;
        assert_eq!(lanes.try_recv(CHANNEL_CTRL), None, "nothing is refused");
        h.terminal.shutdown_graphics().await;
    }

    #[tokio::test]
    #[ignore = "requires cargo build --locked -p merkur-image-worker; real sandbox integration"]
    async fn a_republished_root_encodes_byte_identical_tiles() {
        let mut h = harness().await;
        h.apply(UPLOAD).await;
        let root = h.root(5);
        let source = sampling_source(&h, 5);
        h.request(5, root);
        let first = h.receive(5, source).await;
        h.apply(DELETE).await;
        h.apply(UPLOAD).await;
        assert_eq!(h.root(5), root);
        h.request(6, root);
        let second = h.receive(6, source).await;
        assert!(matches!(first, Received::Tile { .. }));
        assert_eq!(first, second, "a range resume across publications is sound");
        h.terminal.shutdown_graphics().await;
    }

    #[tokio::test]
    #[ignore = "requires cargo build --locked -p merkur-image-worker; real sandbox integration"]
    async fn a_request_ahead_of_its_pairing_report_starts_when_the_report_lands() {
        use crate::network::protocol::EdgeLane;
        let mut h = harness().await;
        h.apply(UPLOAD).await;
        let root = h.root(5);
        let source = sampling_source(&h, 5);
        let (tunnel, report, _lanes) =
            pairing(&h.link, EdgeLane::Interactive, CounterpartState::Pending);
        h.peers.get_mut(PEER).unwrap().edge_tunnel = Some(tunnel);
        let body = request_body(7, root);
        let msg = message(PeerTransport::Edge);
        let peer = h.peers.get_mut(PEER).unwrap();
        handle(
            &msg,
            MSG_TYPE_GRAPHICS_REQUEST,
            &body,
            peer,
            &h.terminal,
            0.0,
        );
        assert_eq!(parked(h.peer()), [7], "no carrier is not a refusal");
        // Nothing else would reap: the owner's wake must come from the report.
        let waiter = || {
            h.peer()
                .graphics_requests
                .as_ref()
                .and_then(|requests| requests.carrier_wait.clone())
                .expect("a request parked for its pairing waits on the report")
        };
        let wait = waiter();
        assert!(!wait.is_finished());
        report.send_replace(attached(1));
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !wait.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the report ends the wait");
        h.settle(|peers| parked(&peers[PEER]).is_empty()).await;
        let Received::Tile { .. } = h.receive(7, source).await else {
            panic!("the pairing report started the request");
        };
        assert_eq!(h.unavailable(), [0u64; 0]);
        h.terminal.shutdown_graphics().await;
    }
}
