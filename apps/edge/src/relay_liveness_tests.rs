//! A browser leg that stops delivering is quoted and held, never closed on
//! probe timeouts. A packet from its host reopens every leg at once, and a relay
//! restarted on its volume resets its old connections within a round trip.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;

use super::tests::{attach_test_peer, read_test_delivery_quote, read_test_lifecycle};
use super::*;
use crate::splice::SPLICE_FINITE_BYTES_GLOBAL;
use tokio::net::UdpSocket;
use wtransport::endpoint::endpoint_side::Client;
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Connection, RecvStream, SendStream};

type Peer = (
    Connection,
    SendStream,
    RecvStream,
    Option<(SendStream, RecvStream)>,
);

/// A UDP relay between clients and one upstream. Each direction can go dark,
/// and the upstream can be replaced under live flows, as a relay restarted
/// behind the same address would be.
struct Proxy {
    address: SocketAddr,
    upstream: Arc<parking_lot::Mutex<SocketAddr>>,
    /// Drop everything the upstream sends to clients.
    down: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl Proxy {
    async fn new(upstream: SocketAddr) -> Self {
        let listener = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let address = listener.local_addr().unwrap();
        let upstream = Arc::new(parking_lot::Mutex::new(upstream));
        let down = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn(relay_datagrams(
            listener,
            Arc::clone(&upstream),
            Arc::clone(&down),
        ));
        Self {
            address,
            upstream,
            down,
            task,
        }
    }

    fn url(&self) -> String {
        format!("https://{}", self.address)
    }

    fn dark(&self, dark: bool) {
        self.down.store(dark, Ordering::Release);
    }

    fn switch(&self, upstream: SocketAddr) {
        *self.upstream.lock() = upstream;
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn relay_datagrams(
    listener: Arc<UdpSocket>,
    upstream: Arc<parking_lot::Mutex<SocketAddr>>,
    down: Arc<AtomicBool>,
) {
    let mut flows: HashMap<SocketAddr, Arc<UdpSocket>> = HashMap::new();
    let mut returns = tokio::task::JoinSet::new();
    let mut packet = vec![0; 65_536];
    while let Ok((length, client)) = listener.recv_from(&mut packet).await {
        let flow = match flows.get(&client) {
            Some(flow) => Arc::clone(flow),
            None => {
                let flow = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
                flows.insert(client, Arc::clone(&flow));
                let (listener, down, returning) =
                    (Arc::clone(&listener), Arc::clone(&down), Arc::clone(&flow));
                returns.spawn(async move {
                    let mut packet = vec![0; 65_536];
                    while let Ok((length, _)) = returning.recv_from(&mut packet).await {
                        if !down.load(Ordering::Acquire) {
                            let _ = listener.send_to(&packet[..length], client).await;
                        }
                    }
                });
                flow
            }
        };
        let target = *upstream.lock();
        let _ = flow.send_to(&packet[..length], target).await;
    }
}

struct Relay {
    server: Arc<Endpoint<Server>>,
    registry: SpliceRegistry,
    accept: tokio::task::JoinHandle<()>,
    cert_hash: [u8; 32],
}

impl Relay {
    fn new() -> Self {
        let cert = EdgeCert::generate(&["localhost"]).unwrap();
        let server = Arc::new(
            build_server(
                &cert,
                "127.0.0.1:0".parse().unwrap(),
                &EndpointSecret::generate().unwrap(),
            )
            .unwrap(),
        );
        let registry = SpliceRegistry::new();
        let accept = tokio::spawn(accept_loop(
            Arc::clone(&server),
            registry.clone(),
            crate::attach_ticket::test_key(),
            crate::egress_budget::test_open_budget(),
        ));
        Self {
            server,
            registry,
            accept,
            cert_hash: cert.cert_hash,
        }
    }

    fn address(&self) -> SocketAddr {
        self.server.local_addr().unwrap()
    }

    fn url(&self) -> String {
        format!("https://{}", self.address())
    }

    fn client(&self) -> Endpoint<Client> {
        client_for(self.cert_hash)
    }

    /// The relay's end of the browser attachment under `label`.
    fn browser_leg(&self, label: &str) -> wtransport::quinn::Connection {
        self.registry
            .transport_for_test(label, Role::Browser)
            .expect("an attached browser leg")
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

/// A peer with the relay's own tuning, granting without a connection limit as
/// Chromium and the daemon do.
fn client_for(cert_hash: [u8; 32]) -> Endpoint<Client> {
    let mut transport = tuned_quic_transport_config();
    transport.receive_window(wtransport::quinn::VarInt::MAX);
    let mut config = ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes([Sha256Digest::new(cert_hash)])
        .build();
    config
        .quic_config_mut()
        .transport_config(Arc::new(transport));
    Endpoint::client(config).unwrap()
}

/// Pair a daemon and a browser under `label`, each over its own route, and
/// consume the pairing reports and the counterpart probe.
async fn attach_pair(
    daemon: (&Endpoint<Client>, &str),
    browser: (&Endpoint<Client>, &str),
    label: &str,
) -> (Peer, Peer) {
    let mut source = attach_test_peer(daemon.0, daemon.1, label, Role::Daemon).await;
    read_test_lifecycle(&mut source.2).await;
    let mut destination = attach_test_peer(browser.0, browser.1, label, Role::Browser).await;
    read_test_lifecycle(&mut destination.2).await;
    read_test_lifecycle(&mut source.2).await;
    read_test_lifecycle(&mut destination.2).await;
    let mut probe = source.0.accept_uni().await.unwrap();
    assert_eq!(probe.read(&mut [0; 1]).await.unwrap(), None);
    (source, destination)
}

/// Poll until `condition` holds.
async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what} did not happen"));
}

/// Nothing in flight on any of these connections, so none has a probe of its
/// own pending when a test darkens a path.
async fn settle(connections: &[&wtransport::quinn::Connection]) {
    eventually("the connections settling", || {
        connections
            .iter()
            .all(|connection| connection.stats().path.bytes_in_flight == 0)
    })
    .await;
}

/// The source half of a finite transfer of `bytes`, before any admission.
async fn open_transfer(source: &Connection, bytes: usize) -> SendStream {
    let mut send = source.open_uni().await.unwrap().await.unwrap();
    send.write_all(&[FINITE_STREAM_FLAG | 0x57]).await.unwrap();
    send.write_all(&(bytes as u32).to_be_bytes()).await.unwrap();
    send
}

/// The destination half of the next transfer, past its 13-byte relay header.
async fn accept_transfer(destination: &Connection) -> RecvStream {
    let mut recv = destination.accept_uni().await.unwrap();
    recv.read_exact(&mut [0; 13]).await.unwrap();
    recv
}

#[tokio::test]
async fn a_bulk_leg_that_loses_its_tail_and_probes_is_held_and_finishes_its_transfer() {
    let relay = Relay::new();
    let proxy = Proxy::new(relay.address()).await;
    let (daemon, browser) = (relay.client(), relay.client());
    let (_daemon_interactive, _browser_interactive) = attach_pair(
        (&daemon, &relay.url()),
        (&browser, &relay.url()),
        "idle",
    )
    .await;
    // Only the bulk leg crosses the lossy route, as in the recorded incident.
    let (source, destination) = attach_pair(
        (&daemon, &relay.url()),
        (&browser, &proxy.url()),
        "idle#bulk",
    )
    .await;
    let leg = relay.browser_leg("idle#bulk");
    settle(&[&leg, destination.0.quic_connection()]).await;
    let budget = relay.registry.global_finite_budget();

    // The tail of a small transfer and the probes after it are lost.
    proxy.dark(true);
    let payload: Vec<u8> = (0..16 * 1024).map(|i| (i % 251) as u8).collect();
    let mut send = open_transfer(&source.0, payload.len()).await;
    send.write_all(&payload).await.unwrap();
    send.finish().await.unwrap();
    eventually("two expired probe timeouts with bytes in flight", || {
        let path = leg.stats().path;
        path.pto_count >= 2 && path.bytes_in_flight != 0
    })
    .await;
    // Past the quote ticks a probe-count verdict would have closed it on.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(leg.close_reason().is_none(), "the relay closed a live leg");
    proxy.dark(false);

    let mut recv = accept_transfer(&destination.0).await;
    let received = recv
        .quic_stream_mut()
        .read_to_end(payload.len())
        .await
        .unwrap();
    assert!(received == payload, "the transfer arrived intact");
    eventually("the relay's FIN acknowledged and its budget released", || {
        budget.available_permits() == SPLICE_FINITE_BYTES_GLOBAL
    })
    .await;
    assert!(leg.close_reason().is_none());
    assert!(destination.0.quic_connection().close_reason().is_none());
}

#[tokio::test]
async fn a_packet_on_one_browser_leg_reopens_its_backed_off_siblings_at_once() {
    let relay = Relay::new();
    let proxy = Proxy::new(relay.address()).await;
    let (daemon, browser) = (relay.client(), relay.client());
    // The browser's host sits behind one route for both legs.
    let (_daemon_interactive, browser_interactive) = attach_pair(
        (&daemon, &relay.url()),
        (&browser, &proxy.url()),
        "host",
    )
    .await;
    let (source, destination) = attach_pair(
        (&daemon, &relay.url()),
        (&browser, &proxy.url()),
        "host#bulk",
    )
    .await;
    let (interactive, bulk) = (relay.browser_leg("host"), relay.browser_leg("host#bulk"));
    settle(&[
        &interactive,
        &bulk,
        browser_interactive.0.quic_connection(),
        destination.0.quic_connection(),
    ])
    .await;
    let budget = relay.registry.global_finite_budget();

    proxy.dark(true);
    let payload = vec![0x5a; 16 * 1024];
    let mut send = open_transfer(&source.0, payload.len()).await;
    send.write_all(&payload).await.unwrap();
    send.finish().await.unwrap();
    eventually("the bulk leg backing off four times", || {
        bulk.stats().path.pto_count >= 4
    })
    .await;
    let own_probe = bulk
        .stats()
        .path
        .loss_detection_deadline
        .expect("the bulk leg's backed-off probe timer is armed");
    proxy.dark(false);
    let healed = Instant::now();

    // One datagram on the interactive leg proves the host reachable.
    browser_interactive.0.send_datagram(b"input").unwrap();
    let mut recv = accept_transfer(&destination.0).await;
    let received = recv
        .quic_stream_mut()
        .read_to_end(payload.len())
        .await
        .unwrap();
    assert!(received == payload);
    eventually("the bulk transfer's FIN acknowledged", || {
        budget.available_permits() == SPLICE_FINITE_BYTES_GLOBAL
    })
    .await;
    let own_wait = own_probe.saturating_duration_since(healed);
    assert!(
        std::time::Instant::now() < own_probe,
        "the bulk leg waited for its own backed-off probe timer: completed after {:?}, its \
         timer was {own_wait:?} away",
        healed.elapsed()
    );
}

/// Three connections to one relay, as a daemon's three tunnels are, behind an
/// address whose relay can be restarted. Returns whether each was reset.
async fn restart_resets(same_secret: bool) -> [bool; 3] {
    let cert = EdgeCert::generate(&["localhost"]).unwrap();
    let secret = EndpointSecret::generate().unwrap();
    let first = build_server(&cert, "127.0.0.1:0".parse().unwrap(), &secret).unwrap();
    let other = EndpointSecret::generate().unwrap();
    let restarted = build_server(
        &cert,
        "127.0.0.1:0".parse().unwrap(),
        if same_secret { &secret } else { &other },
    )
    .unwrap();
    let proxy = Proxy::new(first.local_addr().unwrap()).await;
    let client = client_for(cert.cert_hash);
    let group = wtransport::quinn::ProbeGroup::new();
    let mut tunnels = Vec::new();
    let mut accepted = Vec::new();
    for _ in 0..3 {
        let (tunnel, held) = tokio::join!(client.connect(proxy.url()), async {
            first.accept().await.await.unwrap().accept().await.unwrap()
        });
        let tunnel = tunnel.unwrap();
        tunnel.quic_connection().join_probe_group(&group).unwrap();
        tunnels.push(tunnel);
        accepted.push(held);
    }
    let connections: Vec<_> = tunnels.iter().map(Connection::quic_connection).collect();
    settle(&connections).await;

    // The relay behind the address restarts: its connections are gone, and
    // the first old packet to reach it is the signaling heartbeat.
    proxy.switch(restarted.local_addr().unwrap());
    let restart = Instant::now();
    tunnels[0].quic_connection().ping();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let reset = std::array::from_fn(|index| {
        matches!(
            tunnels[index].quic_connection().close_reason(),
            Some(wtransport::quinn::ConnectionError::Reset)
        )
    });
    assert!(
        restart.elapsed() < Duration::from_secs(4),
        "no keep-alive could have revealed the restart in this window"
    );
    drop(accepted);
    reset
}

#[tokio::test]
async fn a_relay_restarted_on_its_volume_resets_every_old_connection_within_a_round_trip() {
    assert_eq!(restart_resets(true).await, [true; 3]);
}

#[tokio::test]
async fn a_relay_with_another_secret_resets_nothing() {
    assert_eq!(restart_resets(false).await, [false; 3]);
}

#[tokio::test]
async fn records_a_blocked_leg_cannot_send_wait_at_their_source_for_its_replacement() {
    const RECORDS: usize = 200;
    const BODY: usize = 1024;
    let relay = Relay::new();
    let proxy = Proxy::new(relay.address()).await;
    let (daemon, browser) = (relay.client(), relay.client());
    let (source, destination) = attach_pair(
        (&daemon, &relay.url()),
        (&browser, &proxy.url()),
        "strand",
    )
    .await;
    // One durable control lane, proven end to end before the outage.
    let mut lane = source.0.open_uni().await.unwrap().await.unwrap();
    lane.write_all(&[0x02]).await.unwrap();
    let record = |index: usize| {
        let mut record = (BODY as u32).to_be_bytes().to_vec();
        record.extend_from_slice(&(index as u32).to_be_bytes());
        record.resize(4 + BODY, 0x33);
        record
    };
    lane.write_all(&record(usize::MAX >> 32)).await.unwrap();
    let mut old = destination.0.accept_uni().await.unwrap();
    old.read_exact(&mut [0; 9]).await.unwrap();
    old.read_exact(&mut vec![0; 4 + BODY]).await.unwrap();
    let leg = relay.browser_leg("strand");
    settle(&[&leg, destination.0.quic_connection()]).await;

    proxy.dark(true);
    for index in 0..RECORDS {
        lane.write_all(&record(index)).await.unwrap();
    }
    eventually("only probes able to leave the dark leg", || {
        leg.stats().path.send_blocked
    })
    .await;
    let window = leg.stats().path.cwnd as usize;

    // A standby replaces the dark attachment over a working route.
    let mut standby = attach_test_peer(&browser, &relay.url(), "strand", Role::Browser).await;
    read_test_lifecycle(&mut standby.2).await;
    let mut successor = standby.0.accept_uni().await.unwrap();
    successor.read_exact(&mut [0; 9]).await.unwrap();
    let mut indices = Vec::new();
    while indices.last() != Some(&(RECORDS - 1)) {
        let mut received = vec![0; 4 + BODY];
        tokio::time::timeout(Duration::from_secs(10), successor.read_exact(&mut received))
            .await
            .expect("the successor received the waiting records")
            .unwrap();
        indices.push(u32::from_be_bytes(received[4..8].try_into().unwrap()) as usize);
    }
    let first = indices[0];
    assert_eq!(
        indices,
        (first..RECORDS).collect::<Vec<_>>(),
        "the successor receives one contiguous, ordered suffix"
    );
    assert!(
        first * (4 + BODY) <= window + 4 + BODY,
        "{first} records were lost to the dark leg, more than its window of {window} bytes \
         and the one record in progress"
    );
}

#[tokio::test]
async fn a_blocked_browser_leg_discards_its_stale_datagrams_and_is_quoted_at_once() {
    let relay = Relay::new();
    let proxy = Proxy::new(relay.address()).await;
    let (daemon, browser) = (relay.client(), relay.client());
    let (source, destination) = attach_pair(
        (&daemon, &relay.url()),
        (&browser, &proxy.url()),
        "quote",
    )
    .await;
    // Dropping the request half would reset the quotes coming back.
    let (_requests, mut quotes) = source.3.expect("a daemon's quote stream");
    let leg = relay.browser_leg("quote");
    settle(&[&leg, destination.0.quic_connection()]).await;
    let empty = (DATAGRAM_SEND_BUFFER_BYTES - leg.delivery_state().datagram_send_buffer_space) as u64;

    proxy.dark(true);
    // Put the stale population in the browser leg's actual QUIC queue before
    // yielding. Sending it through the daemon would leave an upstream backlog
    // that can reach the relay only AFTER the blocked quote and path recovery;
    // those late arrivals say nothing about clearing this leg's old queue.
    let prefix = wtransport::quinn::VarInt::from_u64(
        wtransport::proto::ids::QStreamId::from_session_id(destination.0.session_id()).into_u64(),
    )
    .unwrap();
    let mut admitted = 0;
    for index in 0..200u32 {
        let mut frame = index.to_be_bytes().to_vec();
        frame.resize(1000, 0x44);
        admitted += usize::from(leg.try_send_datagram_with_prefix(prefix, frame.into()).unwrap());
    }
    assert!(admitted > 0, "the browser leg admitted no stale datagrams");
    assert!(
        (DATAGRAM_SEND_BUFFER_BYTES - leg.delivery_state().datagram_send_buffer_space) as u64 > empty,
        "the stale population was not queued"
    );
    let blocked = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let SpliceDeliveryQuoteEvent::CounterpartDeliveryQuote {
                send_blocked,
                send_buffer_occupied_bytes,
                ..
            } = read_test_delivery_quote(&mut quotes).await;
            if send_blocked {
                return send_buffer_occupied_bytes;
            }
        }
    })
    .await
    .expect("the daemon is quoted a blocked leg");
    assert_eq!(blocked, empty, "the blocked leg still held stale datagrams");

    proxy.dark(false);
    source.0.send_datagram(b"fresh").unwrap();
    let first = tokio::time::timeout(Duration::from_secs(10), destination.0.receive_datagram())
        .await
        .expect("the fresh frame arrives")
        .unwrap();
    assert_eq!(
        first.payload().as_ref(),
        b"fresh",
        "a stale frame drained ahead of the fresh one"
    );
}

/// Datagrams the daemon sends in one packet reach the browser in one packet: the relay reads
/// them as one batch and admits the batch under one egress hold on the browser leg.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn datagrams_the_daemon_sends_in_one_packet_reach_the_browser_in_one() {
    let relay = Relay::new();
    let (daemon, browser) = (relay.client(), relay.client());
    let url = relay.url();
    let (source, destination) = attach_pair((&daemon, &url), (&browser, &url), "packed").await;
    let browser_leg = relay.browser_leg("packed");
    settle(&[
        source.0.quic_connection(),
        destination.0.quic_connection(),
        &browser_leg,
    ])
    .await;
    // Delayed acknowledgments leave within their maximum ACK delay.
    tokio::time::sleep(Duration::from_millis(60)).await;
    let packets = browser_leg.stats().udp_tx.datagrams;
    let frames = browser_leg.stats().frame_tx.datagram;

    {
        let _hold = source.0.hold_egress();
        for fill in 1..=3u8 {
            source.0.send_datagram([fill; 40]).unwrap();
        }
    }
    let mut batch = wtransport::datagram::DatagramBatch::default();
    let mut received = Vec::new();
    while received.len() < 3 {
        tokio::time::timeout(
            Duration::from_secs(5),
            destination.0.receive_datagrams(&mut batch),
        )
        .await
        .expect("the relayed datagrams arrive")
        .unwrap();
        received.extend(batch.payloads().iter().map(|payload| payload[0]));
    }
    assert_eq!(received, [1, 2, 3]);
    assert_eq!(browser_leg.stats().frame_tx.datagram - frames, 3);
    assert_eq!(
        browser_leg.stats().udp_tx.datagrams - packets,
        1,
        "the relay split one packet's datagrams across packets"
    );
}

/// A browser that closes its connection is torn down at once: every pump settles on its own,
/// so its session admission returns before the shutdown safety valve could have fired.
#[tokio::test]
async fn a_closed_browser_returns_its_session_admission_without_the_safety_valve() {
    let relay = Relay::new();
    let (daemon, browser) = (relay.client(), relay.client());
    let url = relay.url();
    let (_source, destination) = attach_pair((&daemon, &url), (&browser, &url), "detach").await;
    let attached = relay.registry.available_session_tasks();

    destination.0.close(VarInt::from_u32(0), b"done");
    tokio::time::timeout(SESSION_PUMP_SHUTDOWN_TIMEOUT, async {
        while relay.registry.available_session_tasks() == attached {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("a browser pump waited out the shutdown safety valve");
}

/// The registry releasing an attachment is how every session's control writer ends. It is not
/// a writer fault, so it neither warns nor closes the connection with the writer's own reason.
#[tokio::test]
async fn a_released_attachment_ends_its_control_writer_without_a_fault() {
    let relay = Relay::new();
    let (daemon, browser) = (relay.client(), relay.client());
    let url = relay.url();
    let (source, _destination) = attach_pair((&daemon, &url), (&browser, &url), "release").await;
    let control = source.0.open_uni().await.unwrap().await.unwrap();
    let (lifecycle_tx, lifecycle_rx) = tokio::sync::watch::channel(None);
    let (_proof_tx, proof_rx) = tokio::sync::watch::channel(None);
    let (_destination_tx, destinations) = tokio::sync::watch::channel(None);

    drop(lifecycle_tx);
    assert_eq!(
        write_splice_lifecycle_controls(
            ContainedStream::new(control),
            lifecycle_rx,
            &source.0,
            proof_rx,
            destinations,
            None,
            PathReports::None,
        )
        .await,
        Ok(())
    );
    assert!(source.0.quic_connection().close_reason().is_none());
}

#[path = "relay_forward_profile.rs"]
pub(super) mod profile;
