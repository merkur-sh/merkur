use super::tests::{attach_test_peer, read_test_lifecycle};
use super::*;
use crate::splice::{MAX_FINITE_STREAM_BYTES, SPLICE_FINITE_BYTES_PER_DIRECTION};
use wtransport::endpoint::endpoint_side::Client;
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Connection, RecvStream, SendStream};

type Peer = (
    Connection,
    SendStream,
    RecvStream,
    Option<(SendStream, RecvStream)>,
);

/// Retention tests advance the transport's pacing and protocol timers together.
/// Production keeps Quinn's precise OS-thread pacer; this runtime is fixture-owned.
#[derive(Debug)]
struct TestRuntime;

impl wtransport::quinn::Runtime for TestRuntime {
    fn new_timer(
        &self,
        at: std::time::Instant,
    ) -> std::pin::Pin<Box<dyn wtransport::quinn::AsyncTimer>> {
        wtransport::quinn::TokioRuntime.new_timer(at)
    }

    fn spawn(&self, future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>) {
        wtransport::quinn::TokioRuntime.spawn(future);
    }

    fn wrap_udp_socket(
        &self,
        socket: std::net::UdpSocket,
    ) -> std::io::Result<Arc<dyn wtransport::quinn::AsyncUdpSocket>> {
        wtransport::quinn::TokioRuntime.wrap_udp_socket(socket)
    }

    fn now(&self) -> std::time::Instant {
        wtransport::quinn::TokioRuntime.now()
    }
}

#[tokio::test]
async fn unclassified_streams_cannot_hold_later_finite_streams_behind_their_headers() {
    let fixture = Fixture::new().await;
    let mut unfinished = Vec::new();
    // QUIC makes lower stream ids visible when a later stream arrives. These
    // four streams have not supplied their HTTP/3 type yet; none may reserve
    // the driver's completed-stream queue ahead of the usable stream.
    for _ in 0..4 {
        unfinished.push(fixture.source.0.quic_connection().open_uni().await.unwrap());
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut send = fixture.open(1).await;
        send.write_all(&[0x5a]).await.unwrap();
        let mut recv = fixture.accept(1).await;
        let mut byte = [0; 1];
        let (sent, received) = tokio::join!(send.finish(), recv.read_exact(&mut byte));
        sent.unwrap();
        received.unwrap();
        assert_eq!(byte, [0x5a]);
        assert_eq!(recv.read(&mut [0; 1]).await.unwrap(), None);
    })
    .await
    .expect("a delayed header must not block a later transfer");
    drop(unfinished);
}

struct Fixture {
    client: Endpoint<Client>,
    accept: tokio::task::JoinHandle<()>,
    registry: SpliceRegistry,
    url: String,
    interactive: [Peer; 2],
    source: Peer,
    destination: Peer,
    source_id: u64,
    destination_id: u64,
}

/// A peer's transport: the edge's tuning, but granting without a connection
/// limit, as Chromium and the daemon do. Per-stream windows stay Quinn's.
fn peer_transport_config() -> wtransport::config::QuicTransportConfig {
    let mut transport = tuned_quic_transport_config();
    transport.receive_window(wtransport::quinn::VarInt::MAX);
    transport
}

/// `transport` with no keep-alive and no idle timer. A connection with nothing
/// in flight then arms no clock of its own, so a paused test clock advances
/// only to the relay's waits and the test's.
fn quiet(
    mut transport: wtransport::config::QuicTransportConfig,
) -> wtransport::config::QuicTransportConfig {
    transport.keep_alive_interval(None);
    transport.max_idle_timeout(None);
    transport
}

impl Fixture {
    async fn new() -> Self {
        Self::with(peer_transport_config()).await
    }

    async fn with(peer_transport: wtransport::config::QuicTransportConfig) -> Self {
        let cert = EdgeCert::generate(&["localhost"]).unwrap();
        let server = build_server(
            &cert,
            "127.0.0.1:0".parse().unwrap(),
            &EndpointSecret::generate().unwrap(),
        )
        .unwrap();
        Self::serve(
            cert,
            server,
            peer_transport,
            Arc::new(wtransport::quinn::TokioRuntime),
        )
        .await
    }

    /// The relay and its peers with no keep-alive or idle timers.
    async fn quiet() -> Self {
        let cert = EdgeCert::generate(&["localhost"]).unwrap();
        let runtime = Arc::new(TestRuntime);
        let server = build_server_with_transport(
            &cert,
            quiet(tuned_quic_transport_config()),
            runtime.clone(),
        );
        Self::serve(cert, server, quiet(peer_transport_config()), runtime).await
    }

    async fn serve(
        cert: EdgeCert,
        server: Endpoint<wtransport::endpoint::endpoint_side::Server>,
        peer_transport: wtransport::config::QuicTransportConfig,
        runtime: Arc<dyn wtransport::quinn::Runtime>,
    ) -> Self {
        let server = Arc::new(server);
        let url = format!("https://127.0.0.1:{}", server.local_addr().unwrap().port());
        let registry = SpliceRegistry::new();
        let accept = tokio::spawn(accept_loop(
            server,
            registry.clone(),
            crate::attach_ticket::test_key(),
            crate::egress_budget::test_open_budget(),
        ));
        let mut config = ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([Sha256Digest::new(cert.cert_hash)])
            .build();
        config
            .quic_config_mut()
            .transport_config(Arc::new(peer_transport));
        let client = Endpoint::client_with_runtime(config, runtime).unwrap();
        // Finite objects share packet credit with the actual interactive attachment.
        let mut interactive_source = attach_test_peer(&client, &url, "finite", Role::Daemon).await;
        read_test_lifecycle(&mut interactive_source.2).await;
        let mut interactive_destination =
            attach_test_peer(&client, &url, "finite", Role::Browser).await;
        read_test_lifecycle(&mut interactive_destination.2).await;
        read_test_lifecycle(&mut interactive_source.2).await;
        read_test_lifecycle(&mut interactive_destination.2).await;
        let mut probe = interactive_source.0.accept_uni().await.unwrap();
        assert_eq!(probe.read(&mut [0; 1]).await.unwrap(), None);
        let mut source = attach_test_peer(&client, &url, "finite#bulk", Role::Daemon).await;
        read_test_lifecycle(&mut source.2).await;
        let mut destination = attach_test_peer(&client, &url, "finite#bulk", Role::Browser).await;
        let source_id = match read_test_lifecycle(&mut destination.2).await {
            SpliceControlEvent::CounterpartPresent {
                counterpart_attachment_id: Some(id),
                ..
            } => id,
            event => panic!("missing source: {event:?}"),
        };
        let destination_id = match read_test_lifecycle(&mut source.2).await {
            SpliceControlEvent::CounterpartAttached {
                counterpart_attachment_id,
            } => counterpart_attachment_id,
            event => panic!("missing destination: {event:?}"),
        };
        read_test_lifecycle(&mut destination.2).await;
        let mut probe = source.0.accept_uni().await.unwrap();
        assert_eq!(probe.read(&mut [0; 1]).await.unwrap(), None);
        Self {
            client,
            accept,
            registry,
            url,
            interactive: [interactive_source, interactive_destination],
            source,
            destination,
            source_id,
            destination_id,
        }
    }

    async fn start(&self, bytes: usize) -> (SendStream, RecvStream) {
        let send = self.open(bytes).await;
        (send, self.accept(bytes).await)
    }

    /// Another session on the same relay, paired as the first: the interactive
    /// pairing its transfers' packet admission needs, then its bulk source and
    /// destination.
    async fn other_session(&self, label: &str) -> ([Peer; 2], Peer, Peer) {
        let interactive = self.pairing(label).await;
        let [source, destination] = self.pairing(&format!("{label}#bulk")).await;
        (interactive, source, destination)
    }

    async fn pairing(&self, label: &str) -> [Peer; 2] {
        let mut source = attach_test_peer(&self.client, &self.url, label, Role::Daemon).await;
        read_test_lifecycle(&mut source.2).await;
        let mut destination = attach_test_peer(&self.client, &self.url, label, Role::Browser).await;
        read_test_lifecycle(&mut destination.2).await;
        read_test_lifecycle(&mut source.2).await;
        read_test_lifecycle(&mut destination.2).await;
        let mut probe = source.0.accept_uni().await.unwrap();
        assert_eq!(probe.read(&mut [0; 1]).await.unwrap(), None);
        [source, destination]
    }

    /// The source half of a transfer: its prefix, before any admission.
    async fn open(&self, bytes: usize) -> SendStream {
        let mut send = self.source.0.open_uni().await.unwrap().await.unwrap();
        // Nonzero opaque tag proves that the relay doesn't parse channel ids.
        send.write_all(&[FINITE_STREAM_FLAG | 0x57]).await.unwrap();
        send.write_all(&(bytes as u32).to_be_bytes()).await.unwrap();
        send
    }

    /// The destination half of the next admitted transfer, past its header.
    async fn accept(&self, bytes: usize) -> RecvStream {
        let mut recv = self.destination.0.accept_uni().await.unwrap();
        let mut prefix = [0; 13];
        recv.read_exact(&mut prefix).await.unwrap();
        assert_eq!(
            u64::from_be_bytes(prefix[..8].try_into().unwrap()),
            self.source_id
        );
        assert_eq!(prefix[8], FINITE_STREAM_FLAG | 0x57);
        assert_eq!(
            u32::from_be_bytes(prefix[9..].try_into().unwrap()) as usize,
            bytes
        );
        recv
    }

    async fn durable(&self, tag: u8) -> (SendStream, RecvStream) {
        let mut send = tokio::time::timeout(Duration::from_secs(2), async {
            self.source.0.open_uni().await.unwrap().await.unwrap()
        })
        .await
        .unwrap_or_else(|_| panic!("source durable stream {tag} credit"));
        send.write_all(&[tag, 0, 0, 0, 1, 7]).await.unwrap();
        let mut recv =
            tokio::time::timeout(Duration::from_secs(2), self.destination.0.accept_uni())
                .await
                .unwrap_or_else(|_| panic!("destination durable stream {tag} credit"))
                .unwrap();
        let mut wire = [0; 14];
        recv.read_exact(&mut wire).await.unwrap();
        assert_eq!(&wire[8..], &[tag, 0, 0, 0, 1, 7]);
        (send, recv)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.source.0.close(VarInt::from_u32(0), b"done");
        self.destination.0.close(VarInt::from_u32(0), b"done");
        for peer in &self.interactive {
            peer.0.close(VarInt::from_u32(0), b"done");
        }
        self.accept.abort();
    }
}

#[tokio::test]
async fn finite_bytes_and_fin_cross_real_splice_and_release_slots() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut fixture = Fixture::new().await;
        for length in [1, 16_384, 16_385, MAX_FINITE_STREAM_BYTES] {
            let (mut send, mut recv) = fixture.start(length).await;
            let payload: Vec<_> = (0..length).map(|i| i as u8).collect();
            let write = async {
                send.write_all(&payload).await.unwrap();
                send.finish().await.unwrap();
            };
            let read = async {
                let received = recv.quic_stream_mut().read_to_end(length).await.unwrap();
                assert_eq!(received, payload);
                assert_eq!(recv.quic_stream_mut().received_reset().await.unwrap(), None);
            };
            tokio::join!(write, read);
        }
        for _ in 0..MAX_FINITE_STREAMS_PER_PEER + 1 {
            let (mut send, mut recv) = fixture.start(1).await;
            send.write_all(&[91]).await.unwrap();
            send.finish().await.unwrap();
            assert_eq!(recv.quic_stream_mut().read_to_end(1).await.unwrap(), [91]);
        }
        let _durable = fixture.durable(0x25).await;
        std::mem::swap(&mut fixture.source, &mut fixture.destination);
        fixture.source_id = fixture.destination_id;
        let (mut send, mut recv) = fixture.start(3).await;
        send.write_all(&[1, 2, 3]).await.unwrap();
        send.finish().await.unwrap();
        assert_eq!(
            recv.quic_stream_mut().read_to_end(3).await.unwrap(),
            [1, 2, 3]
        );
    })
    .await
    .expect("finite delivery must finish");
}

#[tokio::test]
async fn finite_cancellation_and_malformed_lengths_never_close_durable_lanes() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let fixture = Fixture::new().await;
        let (mut durable, mut durable_recv) = fixture.durable(0x31).await;
        let mut unopened = fixture.source.0.open_uni().await.unwrap().await.unwrap();
        unopened.reset(VarInt::from_u32(9)).unwrap();
        for length in [0, MAX_FINITE_STREAM_BYTES + 1] {
            let mut send = fixture.source.0.open_uni().await.unwrap().await.unwrap();
            send.write_all(&[FINITE_STREAM_FLAG]).await.unwrap();
            send.write_all(&(length as u32).to_be_bytes())
                .await
                .unwrap();
            assert!(send.quic_stream().stopped().await.unwrap().is_some());
        }
        for (length, actual) in [(9, 3), (3, 4)] {
            let (mut send, mut recv) = fixture.start(length).await;
            send.write_all(&vec![7; actual]).await.unwrap();
            send.quic_stream_mut().finish().unwrap();
            assert!(recv.quic_stream_mut().read_to_end(32).await.is_err());
        }
        let (mut send, mut recv) = fixture.start(100).await;
        send.reset(VarInt::from_u32(4)).unwrap();
        assert!(recv.quic_stream_mut().read_to_end(100).await.is_err());
        let (send, recv) = fixture.start(100).await;
        recv.stop(VarInt::from_u32(5));
        assert!(send.quic_stream().stopped().await.unwrap().is_some());
        durable.write_all(&[0, 0, 0, 1, 8]).await.unwrap();
        let mut record = [0; 5];
        durable_recv.read_exact(&mut record).await.unwrap();
        assert_eq!(record, [0, 0, 0, 1, 8]);
    })
    .await
    .expect("cancellation must propagate");
}

#[tokio::test]
async fn finite_slots_are_bounded_and_leave_every_durable_slot_available() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let fixture = Fixture::new().await;
        // Exercise all HTTP/3 essential streams, including the QPACK streams
        // a browser may open even though our native client omits them.
        let mut qpack = Vec::new();
        for kind in [2, 3] {
            let mut stream = fixture.source.0.quic_connection().open_uni().await.unwrap();
            stream.write_all(&[kind]).await.unwrap();
            qpack.push(stream);
        }
        let mut finite = Vec::new();
        for _ in 0..MAX_FINITE_STREAMS_PER_PEER {
            finite.push(fixture.start(1).await);
        }
        let mut excess = fixture.source.0.open_uni().await.unwrap().await.unwrap();
        excess.write_all(&[FINITE_STREAM_FLAG]).await.unwrap();
        assert!(excess.quic_stream().stopped().await.unwrap().is_some());
        drop(excess);
        let mut durable = Vec::new();
        for tag in 0..MAX_RELIABLE_LANES_PER_PEER as u8 {
            durable.push(fixture.durable(tag).await);
        }
        let (send, recv) = finite.pop().unwrap();
        recv.stop(VarInt::from_u32(1));
        assert!(send.quic_stream().stopped().await.unwrap().is_some());
        drop(send);
        let _replacement = fixture.start(1).await;
    })
    .await
    .expect("finite capacity must leave durable lanes live");
}

#[tokio::test]
async fn finite_transfer_never_moves_to_a_replacement_destination() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut fixture = Fixture::new().await;
        let (mut send, mut recv) = fixture.start(100).await;
        send.write_all(&[33]).await.unwrap();
        recv.read_exact(&mut [0; 1]).await.unwrap();
        let mut replacement =
            attach_test_peer(&fixture.client, &fixture.url, "finite#bulk", Role::Browser).await;
        read_test_lifecycle(&mut replacement.2).await;
        read_test_lifecycle(&mut fixture.source.2).await;
        assert!(send.quic_stream().stopped().await.unwrap().is_some());
        let old = std::mem::replace(&mut fixture.destination, replacement);
        old.0.close(VarInt::from_u32(7), b"old");
        let (mut fresh, mut received) = fixture.start(1).await;
        fresh.write_all(&[42]).await.unwrap();
        fresh.finish().await.unwrap();
        assert_eq!(
            received.quic_stream_mut().read_to_end(1).await.unwrap(),
            [42]
        );
    })
    .await
    .expect("replacement must retire only the old transfer");
}

#[tokio::test]
async fn finite_budget_charges_the_complete_queue_and_refunds_cancelled_admission() {
    use std::future::{Future, poll_fn};
    use std::task::Poll;
    use tokio::sync::Semaphore;
    let charged = 1024 + 13;
    let budgets = [
        Arc::new(Semaphore::new(charged)),
        Arc::new(Semaphore::new(charged)),
    ];
    let owner = ReliableRecordBudget::acquire_finite(&budgets, 1024)
        .await
        .unwrap();
    assert_eq!(budgets[0].available_permits(), 0);
    assert_eq!(budgets[1].available_permits(), 0);
    drop(owner);
    assert_eq!(budgets[0].available_permits(), charged);
    assert_eq!(budgets[1].available_permits(), charged);
    let global = budgets[1]
        .clone()
        .acquire_many_owned(charged as u32)
        .await
        .unwrap();
    let mut pending = Box::pin(ReliableRecordBudget::acquire_finite(&budgets, 1024));
    poll_fn(|cx| {
        assert!(pending.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert_eq!(budgets[0].available_permits(), 0);
    drop(pending);
    assert_eq!(budgets[0].available_permits(), charged);
    drop(global);
    assert!(
        ReliableRecordBudget::acquire_finite(&budgets, MAX_FINITE_STREAM_BYTES + 1)
            .await
            .is_none()
    );
}

#[test]
fn bulk_credit_is_a_hops_bandwidth_delay_product_within_its_floor_and_ceiling() {
    use super::finite::{BULK_CREDIT_FLOOR, bulk_credit};
    assert_eq!(bulk_credit(0, Duration::from_secs(1)), BULK_CREDIT_FLOOR);
    assert_eq!(bulk_credit(125_000_000, Duration::ZERO), BULK_CREDIT_FLOOR);
    assert_eq!(
        bulk_credit(125_000_000, Duration::from_millis(30)),
        3_750_000 + BULK_CREDIT_FLOOR
    );
    assert_eq!(
        bulk_credit(1_000_000, Duration::from_millis(30)),
        30_000 + BULK_CREDIT_FLOOR
    );
    assert_eq!(
        bulk_credit(u64::MAX, Duration::MAX),
        MAX_FINITE_STREAM_BYTES as u64
    );
}

/// Poll one write; `None` while the source is flow-control blocked.
async fn write_now(send: &mut SendStream, bytes: &[u8]) -> Option<usize> {
    use std::future::{Future, poll_fn};
    use std::task::Poll;
    let mut write = std::pin::pin!(send.write(bytes));
    poll_fn(|cx| {
        Poll::Ready(match write.as_mut().poll(cx) {
            Poll::Ready(result) => Some(result.unwrap()),
            Poll::Pending => None,
        })
    })
    .await
}

/// Quinn's default per-stream receive window, on the edge and on both peers.
const STREAM_WINDOW: usize = 1_250_000;

#[tokio::test]
async fn a_browser_out_of_connection_credit_holds_the_daemons_bulk_to_what_it_took() {
    use super::finite::BULK_CREDIT_FLOOR;
    tokio::time::timeout(Duration::from_secs(20), async {
        // This browser grants only the edge's credit floor for its whole
        // connection, so the relay waits on the drain every stream shares.
        let fixture = Fixture::with(tuned_quic_transport_config()).await;
        let total = 4 * 1024 * 1024;
        let payload: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
        let (mut send, mut recv) = fixture.start(total).await;
        // The browser reads nothing. Whatever the daemon may still write has to
        // fit the edge's hop-by-hop credit: the browser's own grant (its
        // connection window), the one batch the relay holds, and the daemon
        // hop's credit. Keep the earlier regression ceiling (625 KB of upstream
        // allowance) unchanged; the credit arithmetic has separate exact tests.
        // Before hop-by-hop credit the edge let the daemon write a whole
        // stream window (1.25 MB) past a browser that had taken nothing. A
        // shared wait never parks the source: the daemon stays clocked to it.
        let bound = BULK_CREDIT_FLOOR as usize + RELIABLE_READ_MAX_BYTES + 625_000;
        let mut accepted = 0;
        while let Some(written) = write_now(&mut send, &payload[accepted..]).await {
            accepted += written;
            assert!(
                accepted <= bound,
                "{accepted} bytes accepted past a stalled browser; credit bounds it at {bound}"
            );
        }
        assert!(accepted < total);
        // The stalled splice holds nothing in front of interactive traffic.
        fixture.interactive[0]
            .0
            .send_datagram(b"input-ack")
            .unwrap();
        let datagram = fixture.interactive[1].0.receive_datagram().await.unwrap();
        assert_eq!(datagram.payload().as_ref(), b"input-ack");
        // Credit resumes as the browser drains: the whole transfer crosses
        // intact once it reads.
        let write = async {
            send.write_all(&payload[accepted..]).await.unwrap();
            send.finish().await.unwrap();
        };
        let read = async { recv.quic_stream_mut().read_to_end(total).await.unwrap() };
        let ((), received) = tokio::join!(write, read);
        assert!(
            received == payload,
            "the relayed transfer must arrive intact"
        );
    })
    .await
    .expect("a stalled browser must hold, then release, the daemon's bulk");
}

#[tokio::test]
async fn a_stream_its_browser_stopped_reading_parks_only_its_own_credit() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new().await;
        let total = 4 * 1024 * 1024;
        let payload: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
        let (mut send, mut recv) = fixture.start(total).await;
        // The browser reads none of this transfer, so its stream refuses more
        // once the browser's stream window is full, and the edge holds some of
        // what follows unread.
        let mut accepted = 0;
        while accepted < STREAM_WINDOW + RELIABLE_READ_MAX_BYTES + 32 * 1024 {
            accepted += send.write(&payload[accepted..]).await.unwrap();
        }
        // The daemon keeps writing it throughout.
        let stalled = async {
            send.write_all(&payload[accepted..]).await.unwrap();
            send.finish().await.unwrap();
        };
        let others = async {
            // The daemon's other streams keep moving: another transfer and a
            // durable lane's record cross while the first is stalled. Without
            // parking, the stalled stream's unread bytes took the hop's whole
            // connection credit and neither could.
            let other: Vec<u8> = (0..256 * 1024).map(|i| (i % 241) as u8).collect();
            let (mut other_send, mut other_recv) = fixture.start(other.len()).await;
            let write = async {
                other_send.write_all(&other).await.unwrap();
                other_send.finish().await.unwrap();
            };
            let read = async {
                other_recv
                    .quic_stream_mut()
                    .read_to_end(other.len())
                    .await
                    .unwrap()
            };
            let ((), received) = tokio::join!(write, read);
            assert!(received == other, "the other transfer must arrive intact");
            let _durable = fixture.durable(0x42).await;
            fixture.interactive[0]
                .0
                .send_datagram(b"input-ack")
                .unwrap();
            let datagram = fixture.interactive[1].0.receive_datagram().await.unwrap();
            assert_eq!(datagram.payload().as_ref(), b"input-ack");
            // The stalled transfer resumes intact once its reader drains it.
            recv.quic_stream_mut().read_to_end(total).await.unwrap()
        };
        let ((), received) = tokio::join!(stalled, others);
        assert!(
            received == payload,
            "the stalled transfer must arrive intact"
        );
    })
    .await
    .expect("a stalled stream must never stall the daemon's other streams");
}

#[tokio::test]
async fn a_durable_lane_its_browser_stopped_reading_parks_only_its_own_credit() {
    tokio::time::timeout(Duration::from_secs(20), async {
        // Bound both peer queues so an unread record really encounters backpressure.
        let mut transport = peer_transport_config();
        transport.send_window(16 * 1024);
        transport.stream_receive_window(wtransport::quinn::VarInt::from_u32(16 * 1024));
        let fixture = Fixture::with(transport).await;
        let (mut lane, mut lane_recv) = fixture.durable(0x43).await;
        let body = 4 * 1024 * 1024;
        let mut record = (body as u32).to_be_bytes().to_vec();
        record.extend((0..body).map(|i| (i % 239) as u8));
        // The browser reads none of this record until the other transfer lands.
        // A write can be buffered locally; draining proves its bytes left that queue.
        let stalled = async {
            lane.write_all(&record).await.unwrap();
            lane.quic_stream().drained().await;
        };
        let others = async {
            // A transfer on the same connection crosses meanwhile.
            let other: Vec<u8> = (0..256 * 1024).map(|i| (i % 241) as u8).collect();
            let (mut other_send, mut other_recv) = fixture.start(other.len()).await;
            let write = async {
                other_send.write_all(&other).await.unwrap();
                other_send.finish().await.unwrap();
            };
            let read = async {
                other_recv
                    .quic_stream_mut()
                    .read_to_end(other.len())
                    .await
                    .unwrap()
            };
            let ((), received) = tokio::join!(write, read);
            assert!(received == other, "the transfer must arrive intact");
        };
        tokio::pin!(stalled);
        tokio::select! {
            biased;
            () = &mut stalled => panic!("the unread durable record must remain undrained"),
            () = others => {},
        }
        let mut received = vec![0; record.len()];
        let ((), read) = tokio::join!(stalled, lane_recv.read_exact(&mut received));
        read.unwrap();
        assert!(received == record, "the stalled record must arrive intact");
    })
    .await
    .expect("a stalled lane must never stall the daemon's other streams");
}

#[tokio::test]
async fn a_durable_record_waiting_for_budget_parks_only_its_own_credit() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new().await;
        let (mut lane, mut lane_recv) = fixture.durable(0x44).await;
        // Other sessions' records hold the whole durable budget.
        let budget = fixture.registry.global_reliable_budget();
        let held = budget
            .clone()
            .acquire_many_owned(budget.available_permits() as u32)
            .await
            .unwrap();
        let body = 1024 * 1024;
        let mut record = (body as u32).to_be_bytes().to_vec();
        record.extend((0..body).map(|i| (i % 233) as u8));
        let waiting = async { lane.write_all(&record).await.unwrap() };
        let others = async {
            // The record's bytes arrive while it waits; a transfer on the same
            // connection still crosses.
            let other: Vec<u8> = (0..256 * 1024).map(|i| (i % 241) as u8).collect();
            let (mut other_send, mut other_recv) = fixture.start(other.len()).await;
            let write = async {
                other_send.write_all(&other).await.unwrap();
                other_send.finish().await.unwrap();
            };
            let read = async {
                other_recv
                    .quic_stream_mut()
                    .read_to_end(other.len())
                    .await
                    .unwrap()
            };
            let ((), received) = tokio::join!(write, read);
            assert!(received == other, "the transfer must arrive intact");
            drop(held);
            let mut received = vec![0; record.len()];
            lane_recv.read_exact(&mut received).await.unwrap();
            received
        };
        let ((), received) = tokio::join!(waiting, others);
        assert!(received == record, "the record must arrive intact");
    })
    .await
    .expect("a record waiting for budget must never stall the daemon's other streams");
}

/// The daemon sends two transfers at once, round robin, while the second waits
/// for something only the first's completion frees. Its arrivals must not take
/// the credit the first needs to finish.
async fn first_frees_what_second_waits_on(fixture: &Fixture) {
    let size = 1024 * 1024;
    let (mut first, mut first_recv) = fixture.start(size).await;
    let mut second = fixture.open(size).await;
    let first_payload = vec![0x5a; size];
    let second_payload = vec![0xa5; size];
    let writes = async {
        let first = async {
            first.write_all(&first_payload).await.unwrap();
            first.finish().await.unwrap();
        };
        let second = async {
            second.write_all(&second_payload).await.unwrap();
            second.finish().await.unwrap();
        };
        tokio::join!(first, second);
    };
    let reads = async {
        let received = first_recv
            .quic_stream_mut()
            .read_to_end(size)
            .await
            .unwrap();
        assert!(
            received == first_payload,
            "the first transfer arrives intact"
        );
        let mut second_recv = fixture.accept(size).await;
        let received = second_recv
            .quic_stream_mut()
            .read_to_end(size)
            .await
            .unwrap();
        assert!(
            received == second_payload,
            "the second transfer arrives intact"
        );
    };
    tokio::join!(writes, reads);
}

#[tokio::test]
async fn a_transfer_waiting_for_budget_never_holds_the_transfer_it_waits_on() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new().await;
        // Leave the edge's finite budget room for exactly one transfer.
        let budget = fixture.registry.global_finite_budget();
        let hold = budget.available_permits() - (1024 * 1024 + 13);
        let _held = budget.acquire_many_owned(hold as u32).await.unwrap();
        first_frees_what_second_waits_on(&fixture).await;
    })
    .await
    .expect("a transfer waiting for budget must not starve the one holding it");
}

#[tokio::test]
async fn a_transfer_waiting_for_a_browser_stream_never_holds_the_transfer_it_waits_on() {
    tokio::time::timeout(Duration::from_secs(20), async {
        // Each peer takes the edge's HTTP/3 control stream and one more: the
        // second transfer's destination stream opens only once the first's
        // closes.
        let mut transport = peer_transport_config();
        transport.max_concurrent_uni_streams(2u32.into());
        let fixture = Fixture::with(transport).await;
        first_frees_what_second_waits_on(&fixture).await;
    })
    .await
    .expect("a transfer waiting for a stream must not starve the one holding it");
}

/// One raw edge-side connection and its peer, without the relay's routing, so
/// a test applies receive credit and the egress model itself. The peer grants without a connection
/// limit, as Chromium effectively does, and returns its endpoints alive.
async fn credit_pair() -> (
    Endpoint<wtransport::endpoint::endpoint_side::Server>,
    Endpoint<Client>,
    Connection,
    Connection,
) {
    let cert = EdgeCert::generate(&["localhost"]).unwrap();
    let server = build_server(
        &cert,
        "127.0.0.1:0".parse().unwrap(),
        &EndpointSecret::generate().unwrap(),
    )
    .unwrap();
    let url = format!("https://127.0.0.1:{}", server.local_addr().unwrap().port());
    let mut config = ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes([Sha256Digest::new(cert.cert_hash)])
        .build();
    config
        .quic_config_mut()
        .transport_config(Arc::new(peer_transport_config()));
    let client = Endpoint::client(config).unwrap();
    let accept = async { server.accept().await.await.unwrap().accept().await.unwrap() };
    let (edge, peer) = tokio::join!(accept, async { client.connect(&url).await.unwrap() });
    (server, client, edge, peer)
}

#[tokio::test]
async fn routing_preface_keeps_its_place_before_later_bidirectional_control() {
    let (_server, _client, edge, peer) = credit_pair().await;
    let first = peer.open_bi().await.unwrap();
    let (mut later, _recv) = peer.open_bi().await.unwrap().await.unwrap();
    later.write_all(&[0x6b]).await.unwrap();
    // A ready later control stream must not become the routing preface merely
    // because the first stream's header has not arrived yet.
    assert!(
        tokio::time::timeout(Duration::from_millis(20), edge.accept_bi())
            .await
            .is_err()
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        let (mut earlier, _recv) = first.await.unwrap();
        earlier.write_all(&[0x6a]).await.unwrap();
        for expected in [0x6a, 0x6b] {
            let (_send, mut recv) = edge.accept_bi().await.unwrap();
            let mut byte = [0; 1];
            recv.read_exact(&mut byte).await.unwrap();
            assert_eq!(byte, [expected]);
        }
    })
    .await
    .expect("ordered bootstrap streams must complete");
}

#[tokio::test]
async fn the_browser_bulk_hop_holds_image_bytes_to_its_credit_and_no_durable_lane() {
    use super::finite::attach_receive_credit;
    tokio::time::timeout(Duration::from_secs(10), async {
        let (_server, _client, edge, _peer) = credit_pair().await;
        assert!(!attach_receive_credit(
            edge.quic_connection(),
            Role::Browser,
            true
        ));
        let group = edge.quic_connection().start_egress_group().unwrap();
        let mut image = edge.open_uni().await.unwrap().await.unwrap();
        image.set_priority(wtransport::quinn::EGRESS_IMAGE_PRIORITY);
        // The peer would take 1.25 MB on this stream at once; the edge's image
        // send window lets it queue only its credit ahead of the peer's ACKs.
        let model = group.stats();
        let window = model.bulk_cap.saturating_add(model.quantum);
        let accepted = write_now(&mut image, &vec![7; 1 << 20])
            .await
            .expect("an idle hop admits its first write");
        assert!(accepted > 0);
        assert!(
            accepted as u64 <= window,
            "{accepted} bytes queued unacknowledged toward the browser"
        );
        // A display record behind those unacknowledged image bytes is admitted
        // whole at once: priority, not the image window, orders the two.
        let mut durable = edge.open_uni().await.unwrap().await.unwrap();
        let record = vec![9; 256 * 1024];
        assert_eq!(write_now(&mut durable, &record).await, Some(record.len()));
    })
    .await
    .expect("the browser hop must admit a first write");
}

#[tokio::test]
async fn interactive_and_upload_hops_keep_unlimited_connection_credit() {
    use super::finite::attach_receive_credit;
    tokio::time::timeout(Duration::from_secs(10), async {
        let (_server, _client, edge, peer) = credit_pair().await;
        // Every connection opens with only the credit floor; a non-bulk hop
        // must lift it, or a durable lane's large record would wait on reads.
        assert!(!attach_receive_credit(
            edge.quic_connection(),
            Role::Daemon,
            false
        ));
        let mut send = peer.open_uni().await.unwrap().await.unwrap();
        send.write_all(&vec![9; 1 << 20]).await.unwrap();
    })
    .await
    .expect("a non-bulk hop must accept a record larger than the credit floor unread");
}

/// A browser that acknowledges but never reads, for four times the thirty
/// seconds the relay once gave any stalled wait. The fixture runtime puts both
/// transport and pacing deadlines on Tokio's clock before it is paused.
const FROZEN: Duration = Duration::from_secs(120);

async fn freeze_reader() {
    tokio::time::pause();
    tokio::time::sleep(FROZEN).await;
    tokio::time::resume();
}

/// Poll until `condition` holds.
async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what} did not happen"));
}

#[tokio::test]
async fn a_transfer_its_browser_stopped_reading_keeps_its_budget_until_it_reads_again() {
    let fixture = Fixture::quiet().await;
    let budget = fixture.registry.global_finite_budget();
    let idle = budget.available_permits();
    let total = 4 * 1024 * 1024;
    let payload: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
    let (mut send, mut recv) = fixture.start(total).await;
    let charged = total + 13;
    assert_eq!(idle - budget.available_permits(), charged);
    let writer = {
        let payload = payload.clone();
        tokio::spawn(async move {
            send.write_all(&payload).await.unwrap();
            send.finish().await.unwrap();
        })
    };
    freeze_reader().await;
    assert_eq!(
        idle - budget.available_permits(),
        charged,
        "a transfer both of whose pairings stayed up lost its budget"
    );
    assert!(
        !writer.is_finished(),
        "the daemon stays clocked to its frozen reader"
    );
    // The tab thaws: the whole transfer arrives, and its budget returns once
    // the relay's FIN is acknowledged.
    let received = recv.quic_stream_mut().read_to_end(total).await.unwrap();
    assert!(received == payload, "the thawed transfer arrives intact");
    writer.await.unwrap();
    eventually("the delivered transfer's budget returning", || {
        budget.available_permits() == idle
    })
    .await;
}

#[tokio::test]
async fn a_frozen_browser_holds_only_its_sessions_share_while_another_session_moves() {
    let fixture = Fixture::quiet().await;
    let budget = fixture.registry.global_finite_budget();
    let idle = budget.available_permits();
    // The frozen browser's daemon offers whole transfers until its session's
    // share of the relay's finite budget is spent.
    let share = SPLICE_FINITE_BYTES_PER_DIRECTION / (MAX_FINITE_STREAM_BYTES + 13);
    let mut frozen = Vec::new();
    for _ in 0..=share {
        let mut send = fixture.open(MAX_FINITE_STREAM_BYTES).await;
        send.write_all(&[0x5a; 16 * 1024]).await.unwrap();
        frozen.push(send);
    }
    let charged = share * (MAX_FINITE_STREAM_BYTES + 13);
    eventually("the frozen session spending its share", || {
        idle - budget.available_permits() == charged
    })
    .await;
    freeze_reader().await;
    assert_eq!(
        idle - budget.available_permits(),
        charged,
        "the frozen session kept exactly its share, no more and no less"
    );

    // Another session's transfer crosses whole meanwhile.
    let (_interactive, other_source, other_destination) = fixture.other_session("other").await;
    let payload: Vec<u8> = (0..256 * 1024).map(|i| (i % 241) as u8).collect();
    let mut send = other_source.0.open_uni().await.unwrap().await.unwrap();
    send.write_all(&[FINITE_STREAM_FLAG | 0x57]).await.unwrap();
    send.write_all(&(payload.len() as u32).to_be_bytes())
        .await
        .unwrap();
    let write = async {
        send.write_all(&payload).await.unwrap();
        send.finish().await.unwrap();
    };
    let read = async {
        let mut recv = other_destination.0.accept_uni().await.unwrap();
        recv.read_exact(&mut [0; 13]).await.unwrap();
        recv.quic_stream_mut()
            .read_to_end(payload.len())
            .await
            .unwrap()
    };
    let ((), received) = tokio::join!(write, read);
    assert!(
        received == payload,
        "the other session's transfer arrives intact"
    );
    eventually(
        "the other session's delivered transfer returning its budget",
        || idle - budget.available_permits() == charged,
    )
    .await;
    drop(frozen);
}

#[tokio::test]
async fn a_frozen_transfers_source_reset_releases_both_budgets_to_a_waiting_session() {
    let fixture = Fixture::quiet().await;
    let budget = fixture.registry.global_finite_budget();
    // Other sessions hold all but one whole transfer's room.
    let room = MAX_FINITE_STREAM_BYTES + 13;
    let held = budget
        .clone()
        .acquire_many_owned((budget.available_permits() - room) as u32)
        .await
        .unwrap();
    let (mut frozen, _never_read) = fixture.start(MAX_FINITE_STREAM_BYTES).await;
    frozen.write_all(&[0x5a; 64 * 1024]).await.unwrap();
    assert_eq!(budget.available_permits(), 0);

    let (_interactive, other_source, other_destination) = fixture.other_session("other").await;
    let mut waiting = other_source.0.open_uni().await.unwrap().await.unwrap();
    waiting
        .write_all(&[FINITE_STREAM_FLAG | 0x57])
        .await
        .unwrap();
    waiting.write_all(&1024u32.to_be_bytes()).await.unwrap();
    freeze_reader().await;
    assert!(
        tokio::time::timeout(Duration::ZERO, other_destination.0.accept_uni())
            .await
            .is_err(),
        "the waiting transfer was admitted while the frozen one still held its budget"
    );

    // The daemon arms its rebind window for the silent peer and resets its
    // transfers: both budgets return, and the waiting session's transfer goes.
    frozen.reset(VarInt::from_u32(0)).unwrap();
    let mut recv = other_destination.0.accept_uni().await.unwrap();
    recv.read_exact(&mut [0; 13]).await.unwrap();
    waiting.write_all(&[0x61; 1024]).await.unwrap();
    waiting.finish().await.unwrap();
    assert_eq!(
        recv.quic_stream_mut().read_to_end(1024).await.unwrap(),
        [0x61; 1024]
    );
    drop(held);
}
