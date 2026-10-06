#![cfg(any(feature = "rustls-aws-lc-rs", feature = "rustls-ring"))]

#[cfg(all(feature = "rustls-aws-lc-rs", not(feature = "rustls-ring")))]
use rustls::crypto::aws_lc_rs::default_provider;
#[cfg(feature = "rustls-ring")]
use rustls::crypto::ring::default_provider;

use std::{
    convert::TryInto,
    future::Future,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket},
    pin::pin,
    str,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll, RawWaker, RawWakerVTable, Waker},
};

use crate::runtime::TokioRuntime;
use crate::{Duration, Instant};
use bytes::Bytes;
use proto::{RandomConnectionIdGenerator, crypto::rustls::QuicClientConfig};
use rand::{RngCore, SeedableRng, rngs::StdRng};
use rustls::{
    RootCertStore,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
};
use tokio::time::{sleep, timeout};
use tokio::{
    join,
    runtime::{Builder, Runtime},
};
use tracing::{error_span, info};
use tracing_futures::Instrument as _;
use tracing_subscriber::EnvFilter;

use super::{ClientConfig, Endpoint, EndpointConfig, RecvStream, SendStream, TransportConfig};

#[test]
fn handshake_timeout() {
    let _guard = subscribe();
    let runtime = rt_threaded();
    let client = {
        let _guard = runtime.enter();
        Endpoint::client(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap()
    };

    // Avoid NoRootAnchors error
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(cert.cert.into()).unwrap();

    let mut client_config = crate::ClientConfig::with_root_certificates(Arc::new(roots)).unwrap();
    const IDLE_TIMEOUT: Duration = Duration::from_millis(500);
    let mut transport_config = crate::TransportConfig::default();
    transport_config
        .max_idle_timeout(Some(IDLE_TIMEOUT.try_into().unwrap()))
        .initial_rtt(Duration::from_millis(10));
    client_config.transport_config(Arc::new(transport_config));

    let start = Instant::now();
    runtime.block_on(async move {
        match client
            .connect_with(
                client_config,
                SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1),
                "localhost",
            )
            .unwrap()
            .await
        {
            Err(crate::ConnectionError::TimedOut) => {}
            Err(e) => panic!("unexpected error: {e:?}"),
            Ok(_) => panic!("unexpected success"),
        }
    });
    let dt = start.elapsed();
    assert!(dt > IDLE_TIMEOUT && dt < 2 * IDLE_TIMEOUT);
}

#[tokio::test]
async fn close_endpoint() {
    let _guard = subscribe();

    // Avoid NoRootAnchors error
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(cert.cert.into()).unwrap();

    let mut endpoint =
        Endpoint::client(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap();
    endpoint
        .set_default_client_config(ClientConfig::with_root_certificates(Arc::new(roots)).unwrap());

    let conn = endpoint
        .connect(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1234),
            "localhost",
        )
        .unwrap();

    tokio::spawn(async move {
        let _ = conn.await;
    });

    let conn = endpoint
        .connect(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1234),
            "localhost",
        )
        .unwrap();
    endpoint.close(0u32.into(), &[]);
    match conn.await {
        Err(crate::ConnectionError::LocallyClosed) => (),
        Err(e) => panic!("unexpected error: {e}"),
        Ok(_) => {
            panic!("unexpected success");
        }
    }
}

#[test]
fn local_addr() {
    let socket = UdpSocket::bind((Ipv6Addr::LOCALHOST, 0)).unwrap();
    let addr = socket.local_addr().unwrap();
    let runtime = rt_basic();
    let ep = {
        let _guard = runtime.enter();
        Endpoint::new(Default::default(), None, socket, Arc::new(TokioRuntime)).unwrap()
    };
    assert_eq!(
        addr,
        ep.local_addr()
            .expect("Could not obtain our local endpoint")
    );
}

#[test]
fn read_after_close() {
    let _guard = subscribe();
    let runtime = rt_basic();
    let endpoint = {
        let _guard = runtime.enter();
        endpoint()
    };

    const MSG: &[u8] = b"goodbye!";
    let endpoint2 = endpoint.clone();
    runtime.spawn(async move {
        let new_conn = endpoint2
            .accept()
            .await
            .expect("endpoint")
            .await
            .expect("connection");
        let mut s = new_conn.open_uni().await.unwrap();
        s.write_all(MSG).await.unwrap();
        s.finish().unwrap();
        // Wait for the stream to be closed, one way or another.
        _ = s.stopped().await;
    });
    runtime.block_on(async move {
        let new_conn = endpoint
            .connect(endpoint.local_addr().unwrap(), "localhost")
            .unwrap()
            .await
            .expect("connect");
        sleep(Duration::from_millis(100)).await;
        let mut stream = new_conn.accept_uni().await.expect("incoming streams");
        let msg = stream.read_to_end(usize::MAX).await.expect("read_to_end");
        assert_eq!(msg, MSG);
    });
}

#[test]
fn export_keying_material() {
    let _guard = subscribe();
    let runtime = rt_basic();
    let endpoint = {
        let _guard = runtime.enter();
        endpoint()
    };

    runtime.block_on(async move {
        let outgoing_conn_fut = tokio::spawn({
            let endpoint = endpoint.clone();
            async move {
                endpoint
                    .connect(endpoint.local_addr().unwrap(), "localhost")
                    .unwrap()
                    .await
                    .expect("connect")
            }
        });
        let incoming_conn_fut = tokio::spawn({
            let endpoint = endpoint.clone();
            async move {
                endpoint
                    .accept()
                    .await
                    .expect("endpoint")
                    .await
                    .expect("connection")
            }
        });
        let outgoing_conn = outgoing_conn_fut.await.unwrap();
        let incoming_conn = incoming_conn_fut.await.unwrap();
        let mut i_buf = [0u8; 64];
        incoming_conn
            .export_keying_material(&mut i_buf, b"asdf", b"qwer")
            .unwrap();
        let mut o_buf = [0u8; 64];
        outgoing_conn
            .export_keying_material(&mut o_buf, b"asdf", b"qwer")
            .unwrap();
        assert_eq!(&i_buf[..], &o_buf[..]);
    });
}

#[tokio::test]
async fn ip_blocking() {
    let _guard = subscribe();
    let endpoint_factory = EndpointFactory::new();
    let client_1 = endpoint_factory.endpoint();
    let client_1_addr = client_1.local_addr().unwrap();
    let client_2 = endpoint_factory.endpoint();
    let server = endpoint_factory.endpoint();
    let server_addr = server.local_addr().unwrap();
    let server_task = tokio::spawn(async move {
        loop {
            let accepting = server.accept().await.unwrap();
            if accepting.remote_address() == client_1_addr {
                accepting.refuse();
            } else if accepting.remote_address_validated() {
                accepting.await.expect("connection");
            } else {
                accepting.retry().unwrap();
            }
        }
    });
    tokio::join!(
        async move {
            let e = client_1
                .connect(server_addr, "localhost")
                .unwrap()
                .await
                .expect_err("server should have blocked this");
            assert!(
                matches!(e, crate::ConnectionError::ConnectionClosed(_)),
                "wrong error"
            );
        },
        async move {
            client_2
                .connect(server_addr, "localhost")
                .unwrap()
                .await
                .expect("connect");
        }
    );
    server_task.abort();
}

/// Construct an endpoint suitable for connecting to itself
fn endpoint() -> Endpoint {
    EndpointFactory::new().endpoint()
}

fn endpoint_with_config(transport_config: TransportConfig) -> Endpoint {
    EndpointFactory::new().endpoint_with_config(transport_config)
}

/// Constructs endpoints suitable for connecting to themselves and each other
struct EndpointFactory {
    cert: rcgen::CertifiedKey<rcgen::KeyPair>,
    endpoint_config: EndpointConfig,
}

impl EndpointFactory {
    fn new() -> Self {
        Self {
            cert: rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap(),
            endpoint_config: EndpointConfig::default(),
        }
    }

    fn endpoint(&self) -> Endpoint {
        self.endpoint_with_config(TransportConfig::default())
    }

    fn endpoint_with_config(&self, transport_config: TransportConfig) -> Endpoint {
        let key = PrivateKeyDer::Pkcs8(self.cert.signing_key.serialize_der().into());
        let transport_config = Arc::new(transport_config);
        let mut server_config =
            crate::ServerConfig::with_single_cert(vec![self.cert.cert.der().clone()], key).unwrap();
        server_config.transport_config(transport_config.clone());

        let mut roots = rustls::RootCertStore::empty();
        roots.add(self.cert.cert.der().clone()).unwrap();
        let mut endpoint = Endpoint::new(
            self.endpoint_config.clone(),
            Some(server_config),
            UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap(),
            Arc::new(TokioRuntime),
        )
        .unwrap();
        let mut client_config = ClientConfig::with_root_certificates(Arc::new(roots)).unwrap();
        client_config.transport_config(transport_config);
        endpoint.set_default_client_config(client_config);

        endpoint
    }
}

/// The server reads the address the handshake proved as soon as it accepts,
/// and hears of a move only once the peer has answered on its new path.
#[tokio::test]
async fn validated_path_follows_a_peer_that_moves() {
    let _guard = subscribe();
    let factory = EndpointFactory::new();
    let server = factory.endpoint();
    let client = factory.endpoint();
    let server_addr = server.local_addr().unwrap();

    let (client_conn, server_conn) = tokio::join!(
        async {
            client
                .connect(server_addr, "localhost")
                .unwrap()
                .await
                .expect("client connects")
        },
        async {
            server
                .accept()
                .await
                .expect("an incoming connection")
                .await
                .expect("server accepts")
        },
    );

    let mut validated = server_conn.validated_path();
    let first = (*validated.borrow_and_update()).expect("the handshake proved a path");
    assert_eq!(first.sequence, 1);
    assert_eq!(first.remote, client.local_addr().unwrap());

    client
        .rebind(UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap())
        .unwrap();
    let moved_to = client.local_addr().unwrap();
    assert_ne!(moved_to, first.remote);

    tokio::time::timeout(Duration::from_secs(5), validated.changed())
        .await
        .expect("the move is announced")
        .expect("the connection is alive");
    let moved = (*validated.borrow_and_update()).expect("still validated");
    assert_eq!(moved.sequence, 2);
    assert_eq!(moved.remote, moved_to);
    drop(client_conn);
}

#[tokio::test]
async fn zero_rtt() {
    let _guard = subscribe();
    let endpoint = endpoint();

    const MSG0: &[u8] = b"zero";
    const MSG1: &[u8] = b"one";
    let endpoint2 = endpoint.clone();
    tokio::spawn(async move {
        for _ in 0..2 {
            let incoming = endpoint2.accept().await.unwrap().accept().unwrap();
            let (connection, established) = incoming.into_0rtt().unwrap_or_else(|_| unreachable!());
            let c = connection.clone();
            tokio::spawn(async move {
                while let Ok(mut x) = c.accept_uni().await {
                    let msg = x.read_to_end(usize::MAX).await.unwrap();
                    assert_eq!(msg, MSG0);
                }
            });
            info!("sending 0.5-RTT");
            let mut s = connection.open_uni().await.expect("open_uni");
            s.write_all(MSG0).await.expect("write");
            s.finish().unwrap();
            established.await;
            info!("sending 1-RTT");
            let mut s = connection.open_uni().await.expect("open_uni");
            s.write_all(MSG1).await.expect("write");
            // The peer might close the connection before ACKing
            let _ = s.finish();
        }
    });

    let connection = endpoint
        .connect(endpoint.local_addr().unwrap(), "localhost")
        .unwrap()
        .into_0rtt()
        .err()
        .expect("0-RTT succeeded without keys")
        .await
        .expect("connect");

    {
        let mut stream = connection.accept_uni().await.expect("incoming streams");
        let msg = stream.read_to_end(usize::MAX).await.expect("read_to_end");
        assert_eq!(msg, MSG0);
        // Read a 1-RTT message to ensure the handshake completes fully, allowing the server's
        // NewSessionTicket frame to be received.
        let mut stream = connection.accept_uni().await.expect("incoming streams");
        let msg = stream.read_to_end(usize::MAX).await.expect("read_to_end");
        assert_eq!(msg, MSG1);
        drop(connection);
    }

    info!("initial connection complete");

    let (connection, zero_rtt) = endpoint
        .connect(endpoint.local_addr().unwrap(), "localhost")
        .unwrap()
        .into_0rtt()
        .unwrap_or_else(|_| panic!("missing 0-RTT keys"));
    // Send something ASAP to use 0-RTT
    let c = connection.clone();
    tokio::spawn(async move {
        let mut s = c.open_uni().await.expect("0-RTT open uni");
        info!("sending 0-RTT");
        s.write_all(MSG0).await.expect("0-RTT write");
        s.finish().unwrap();
    });

    let mut stream = connection.accept_uni().await.expect("incoming streams");
    let msg = stream.read_to_end(usize::MAX).await.expect("read_to_end");
    assert_eq!(msg, MSG0);
    assert!(zero_rtt.await);

    drop((stream, connection));

    endpoint.wait_idle().await;
}

#[test]
#[cfg_attr(
    any(target_os = "solaris", target_os = "illumos"),
    ignore = "Fails on Solaris and Illumos"
)]
fn echo_v6() {
    run_echo(EchoArgs {
        client_addr: SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
        server_addr: SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 0),
        nr_streams: 1,
        stream_size: 10 * 1024,
        receive_window: None,
        stream_receive_window: None,
    });
}

#[test]
#[cfg_attr(target_os = "solaris", ignore = "Sometimes hangs in poll() on Solaris")]
fn echo_v4() {
    run_echo(EchoArgs {
        client_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
        server_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        nr_streams: 1,
        stream_size: 10 * 1024,
        receive_window: None,
        stream_receive_window: None,
    });
}

#[test]
#[cfg_attr(target_os = "solaris", ignore = "Hangs in poll() on Solaris")]
fn echo_dualstack() {
    run_echo(EchoArgs {
        client_addr: SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
        server_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        nr_streams: 1,
        stream_size: 10 * 1024,
        receive_window: None,
        stream_receive_window: None,
    });
}

#[test]
#[ignore]
#[cfg_attr(target_os = "solaris", ignore = "Hangs in poll() on Solaris")]
fn stress_receive_window() {
    run_echo(EchoArgs {
        client_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
        server_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        nr_streams: 50,
        stream_size: 25 * 1024 + 11,
        receive_window: Some(37),
        stream_receive_window: Some(100 * 1024 * 1024),
    });
}

#[test]
#[ignore]
#[cfg_attr(target_os = "solaris", ignore = "Hangs in poll() on Solaris")]
fn stress_stream_receive_window() {
    // Note that there is no point in running this with too many streams,
    // since the window is only active within a stream.
    run_echo(EchoArgs {
        client_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
        server_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        nr_streams: 2,
        stream_size: 250 * 1024 + 11,
        receive_window: Some(100 * 1024 * 1024),
        stream_receive_window: Some(37),
    });
}

#[test]
#[ignore]
#[cfg_attr(target_os = "solaris", ignore = "Hangs in poll() on Solaris")]
fn stress_both_windows() {
    run_echo(EchoArgs {
        client_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
        server_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        nr_streams: 50,
        stream_size: 25 * 1024 + 11,
        receive_window: Some(37),
        stream_receive_window: Some(37),
    });
}

fn run_echo(args: EchoArgs) {
    let _guard = subscribe();
    let runtime = rt_basic();
    let handle = {
        // Use small receive windows
        let mut transport_config = TransportConfig::default();
        if let Some(receive_window) = args.receive_window {
            transport_config.receive_window(receive_window.try_into().unwrap());
        }
        if let Some(stream_receive_window) = args.stream_receive_window {
            transport_config.stream_receive_window(stream_receive_window.try_into().unwrap());
        }
        transport_config.max_concurrent_bidi_streams(1_u8.into());
        transport_config.max_concurrent_uni_streams(1_u8.into());
        let transport_config = Arc::new(transport_config);

        // We don't use the `endpoint` helper here because we want two different endpoints with
        // different addresses.
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let key = PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der());
        let cert = CertificateDer::from(cert.cert);
        let mut server_config =
            crate::ServerConfig::with_single_cert(vec![cert.clone()], key.into()).unwrap();

        server_config.transport = transport_config.clone();
        let server_sock = UdpSocket::bind(args.server_addr).unwrap();
        let server_addr = server_sock.local_addr().unwrap();
        let server = {
            let _guard = runtime.enter();
            let _guard = error_span!("server").entered();
            Endpoint::new(
                Default::default(),
                Some(server_config),
                server_sock,
                Arc::new(TokioRuntime),
            )
            .unwrap()
        };

        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert).unwrap();
        let mut client_crypto =
            rustls::ClientConfig::builder_with_provider(default_provider().into())
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth();
        client_crypto.key_log = Arc::new(rustls::KeyLogFile::new());

        let mut client = {
            let _guard = runtime.enter();
            let _guard = error_span!("client").entered();
            Endpoint::client(args.client_addr).unwrap()
        };
        let mut client_config =
            ClientConfig::new(Arc::new(QuicClientConfig::try_from(client_crypto).unwrap()));
        client_config.transport_config(transport_config);
        client.set_default_client_config(client_config);

        let handle = runtime.spawn(async move {
            let incoming = server.accept().await.unwrap();

            // Note for anyone modifying the platform support in this test:
            // If `local_ip` gets available on additional platforms - which
            // requires modifying this test - please update the list of supported
            // platforms in the doc comment of `quinn_udp::RecvMeta::dst_ip`.
            if cfg!(target_os = "linux")
                || cfg!(target_os = "android")
                || cfg!(target_os = "freebsd")
                || cfg!(target_os = "openbsd")
                || cfg!(target_os = "netbsd")
                || cfg!(target_os = "macos")
                || cfg!(target_os = "windows")
            {
                let local_ip = incoming.local_ip().expect("Local IP must be available");
                assert!(local_ip.is_loopback());
            } else {
                assert_eq!(None, incoming.local_ip());
            }

            let new_conn = incoming.await.unwrap();
            tokio::spawn(async move {
                while let Ok(stream) = new_conn.accept_bi().await {
                    tokio::spawn(echo(stream));
                }
            });
            server.wait_idle().await;
        });

        info!("connecting from {} to {}", args.client_addr, server_addr);
        runtime.block_on(
            async move {
                let new_conn = client
                    .connect(server_addr, "localhost")
                    .unwrap()
                    .await
                    .expect("connect");

                /// This is just an arbitrary number to generate deterministic test data
                const SEED: u64 = 0x12345678;

                for i in 0..args.nr_streams {
                    println!("Opening stream {i}");
                    let (mut send, mut recv) = new_conn.open_bi().await.expect("stream open");
                    let msg = gen_data(args.stream_size, SEED);

                    let send_task = async {
                        send.write_all(&msg).await.expect("write");
                        send.finish().unwrap();
                    };
                    let recv_task = async { recv.read_to_end(usize::MAX).await.expect("read") };

                    let (_, data) = tokio::join!(send_task, recv_task);

                    assert_eq!(data[..], msg[..], "Data mismatch");
                }
                new_conn.close(0u32.into(), b"done");
                client.wait_idle().await;
            }
            .instrument(error_span!("client")),
        );
        handle
    };
    runtime.block_on(handle).unwrap();
}

struct EchoArgs {
    client_addr: SocketAddr,
    server_addr: SocketAddr,
    nr_streams: usize,
    stream_size: usize,
    receive_window: Option<u64>,
    stream_receive_window: Option<u64>,
}

async fn echo((mut send, mut recv): (SendStream, RecvStream)) {
    loop {
        // These are 32 buffers, for reading approximately 32kB at once
        #[rustfmt::skip]
        let mut bufs = [
            Bytes::new(), Bytes::new(), Bytes::new(), Bytes::new(),
            Bytes::new(), Bytes::new(), Bytes::new(), Bytes::new(),
            Bytes::new(), Bytes::new(), Bytes::new(), Bytes::new(),
            Bytes::new(), Bytes::new(), Bytes::new(), Bytes::new(),
            Bytes::new(), Bytes::new(), Bytes::new(), Bytes::new(),
            Bytes::new(), Bytes::new(), Bytes::new(), Bytes::new(),
            Bytes::new(), Bytes::new(), Bytes::new(), Bytes::new(),
            Bytes::new(), Bytes::new(), Bytes::new(), Bytes::new(),
        ];

        match recv.read_chunks(&mut bufs).await.expect("read chunks") {
            Some(n) => {
                send.write_all_chunks(&mut bufs[..n])
                    .await
                    .expect("write chunks");
            }
            None => break,
        }
    }

    let _ = send.finish();
}

fn gen_data(size: usize, seed: u64) -> Vec<u8> {
    let mut rng: StdRng = SeedableRng::seed_from_u64(seed);
    let mut buf = vec![0; size];
    rng.fill_bytes(&mut buf);
    buf
}

fn subscribe() -> tracing::subscriber::DefaultGuard {
    let sub = tracing_subscriber::FmtSubscriber::builder()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(|| TestWriter)
        .finish();
    tracing::subscriber::set_default(sub)
}

struct TestWriter;

impl std::io::Write for TestWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        print!(
            "{}",
            str::from_utf8(buf).expect("tried to log invalid UTF-8")
        );
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        io::stdout().flush()
    }
}

fn rt_basic() -> Runtime {
    Builder::new_current_thread().enable_all().build().unwrap()
}

fn rt_threaded() -> Runtime {
    Builder::new_multi_thread().enable_all().build().unwrap()
}

#[tokio::test]
async fn rebind_recv() {
    let _guard = subscribe();

    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let key = PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der());
    let cert = CertificateDer::from(cert.cert);

    let mut roots = rustls::RootCertStore::empty();
    roots.add(cert.clone()).unwrap();

    let mut client = Endpoint::client(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap();
    let mut client_config = ClientConfig::with_root_certificates(Arc::new(roots)).unwrap();
    client_config.transport_config(Arc::new({
        let mut cfg = TransportConfig::default();
        cfg.max_concurrent_uni_streams(1u32.into());
        cfg
    }));
    client.set_default_client_config(client_config);

    let server_config =
        crate::ServerConfig::with_single_cert(vec![cert.clone()], key.into()).unwrap();
    let server = {
        let _guard = tracing::error_span!("server").entered();
        Endpoint::server(
            server_config,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        )
        .unwrap()
    };
    let server_addr = server.local_addr().unwrap();

    const MSG: &[u8; 5] = b"hello";

    let write_send = Arc::new(tokio::sync::Notify::new());
    let write_recv = write_send.clone();
    let connected_send = Arc::new(tokio::sync::Notify::new());
    let connected_recv = connected_send.clone();
    let server = tokio::spawn(async move {
        let connection = server.accept().await.unwrap().await.unwrap();
        info!("got conn");
        connected_send.notify_one();
        write_recv.notified().await;
        let mut stream = connection.open_uni().await.unwrap();
        stream.write_all(MSG).await.unwrap();
        stream.finish().unwrap();
        // Wait for the stream to be closed, one way or another.
        _ = stream.stopped().await;
    });

    let connection = {
        let _guard = tracing::error_span!("client").entered();
        client
            .connect(server_addr, "localhost")
            .unwrap()
            .await
            .unwrap()
    };
    info!("connected");
    connected_recv.notified().await;
    client
        .rebind(UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap())
        .unwrap();
    info!("rebound");
    write_send.notify_one();
    let mut stream = connection.accept_uni().await.unwrap();
    assert_eq!(stream.read_to_end(MSG.len()).await.unwrap(), MSG);
    server.await.unwrap();
}

#[tokio::test]
async fn stream_id_flow_control() {
    let _guard = subscribe();
    let mut cfg = TransportConfig::default();
    cfg.max_concurrent_uni_streams(1u32.into());
    let endpoint = endpoint_with_config(cfg);

    let (client, server) = tokio::join!(
        endpoint
            .connect(endpoint.local_addr().unwrap(), "localhost")
            .unwrap(),
        async { endpoint.accept().await.unwrap().await }
    );
    let client = client.unwrap();
    let server = server.unwrap();

    // If `open_uni` doesn't get unblocked when the previous stream is dropped, this will time out.
    tokio::join!(
        async {
            client.open_uni().await.unwrap();
        },
        async {
            client.open_uni().await.unwrap();
        },
        async {
            client.open_uni().await.unwrap();
        },
        async {
            server.accept_uni().await.unwrap();
            server.accept_uni().await.unwrap();
        }
    );
}

#[tokio::test]
async fn two_datagram_readers() {
    let _guard = subscribe();
    let endpoint = endpoint();

    let (client, server) = tokio::join!(
        endpoint
            .connect(endpoint.local_addr().unwrap(), "localhost")
            .unwrap(),
        async { endpoint.accept().await.unwrap().await }
    );
    let client = client.unwrap();
    let server = server.unwrap();

    let done = tokio::sync::Notify::new();
    let (a, b, ()) = tokio::join!(
        async {
            let x = client.read_datagram().await.unwrap();
            done.notify_waiters();
            x
        },
        async {
            let x = client.read_datagram().await.unwrap();
            done.notify_waiters();
            x
        },
        async {
            server.send_datagram(b"one"[..].into()).unwrap();
            done.notified().await;
            server.send_datagram_wait(b"two"[..].into()).await.unwrap();
        }
    );
    assert!(*a == *b"one" || *b == *b"one");
    assert!(*a == *b"two" || *b == *b"two");
}

#[tokio::test]
async fn multiple_conns_with_zero_length_cids() {
    let _guard = subscribe();
    let mut factory = EndpointFactory::new();
    factory
        .endpoint_config
        .cid_generator(|| Box::new(RandomConnectionIdGenerator::new(0)));
    let server = {
        let _guard = error_span!("server").entered();
        factory.endpoint()
    };
    let server_addr = server.local_addr().unwrap();

    let client1 = {
        let _guard = error_span!("client1").entered();
        factory.endpoint()
    };
    let client2 = {
        let _guard = error_span!("client2").entered();
        factory.endpoint()
    };

    let client1 = async move {
        let conn = client1
            .connect(server_addr, "localhost")
            .unwrap()
            .await
            .unwrap();
        conn.closed().await;
    }
    .instrument(error_span!("client1"));
    let client2 = async move {
        let conn = client2
            .connect(server_addr, "localhost")
            .unwrap()
            .await
            .unwrap();
        conn.closed().await;
    }
    .instrument(error_span!("client2"));
    let server = async move {
        let client1 = server.accept().await.unwrap().await.unwrap();
        let client2 = server.accept().await.unwrap().await.unwrap();
        // Both connections are now concurrently live.
        client1.close(42u32.into(), &[]);
        client2.close(42u32.into(), &[]);
    }
    .instrument(error_span!("server"));
    tokio::join!(client1, client2, server);
}

#[tokio::test]
async fn stream_stopped() {
    let _guard = subscribe();
    let factory = EndpointFactory::new();
    let server = {
        let _guard = error_span!("server").entered();
        factory.endpoint()
    };
    let server_addr = server.local_addr().unwrap();

    let client = {
        let _guard = error_span!("client1").entered();
        factory.endpoint()
    };

    let client = async move {
        let conn = client
            .connect(server_addr, "localhost")
            .unwrap()
            .await
            .unwrap();
        let mut stream = conn.open_uni().await.unwrap();
        let stopped1 = stream.stopped();
        let stopped2 = stream.stopped();
        let stopped3 = stream.stopped();

        stream.write_all(b"hi").await.unwrap();
        // spawn one of the futures into a task
        let stopped1 = tokio::task::spawn(stopped1);
        // verify that both futures resolved
        let (stopped1, stopped2) = tokio::join!(stopped1, stopped2);
        assert!(matches!(stopped1, Ok(Ok(Some(val))) if val == 42u32.into()));
        assert!(matches!(stopped2, Ok(Some(val)) if val == 42u32.into()));
        // drop the stream
        drop(stream);
        // verify that a future also resolves after dropping the stream
        let stopped3 = stopped3.await;
        assert_eq!(stopped3, Ok(Some(42u32.into())));
    };
    let client = timeout(Duration::from_millis(100), client).instrument(error_span!("client"));
    let server = async move {
        let conn = server.accept().await.unwrap().await.unwrap();
        let mut stream = conn.accept_uni().await.unwrap();
        let mut buf = [0u8; 2];
        stream.read_exact(&mut buf).await.unwrap();
        stream.stop(42u32.into()).unwrap();
        conn
    }
    .instrument(error_span!("server"));
    let (client, conn) = tokio::join!(client, server);
    client.expect("timeout");
    drop(conn);
}

#[tokio::test]
async fn stream_stopped_2() {
    let _guard = subscribe();
    let endpoint = endpoint();

    let (conn, _server_conn) = tokio::try_join!(
        endpoint
            .connect(endpoint.local_addr().unwrap(), "localhost")
            .unwrap(),
        async { endpoint.accept().await.unwrap().await }
    )
    .unwrap();
    let send_stream = conn.open_uni().await.unwrap();
    let stopped = timeout(Duration::from_millis(100), send_stream.stopped())
        .instrument(error_span!("stopped"));
    tokio::pin!(stopped);
    // poll the future once so that the waker is registered.
    tokio::select! {
        biased;
        _x = &mut stopped => {},
        _x = std::future::ready(()) => {}
    }
    // drop the send stream
    drop(send_stream);
    // make sure the stopped future still resolves
    let res = stopped.await;
    assert_eq!(res, Ok(Ok(None)));
}

#[tokio::test]
async fn stream_drop_removes_blocked_reader() {
    let _guard = subscribe();

    for drop_stream in [false, true] {
        let endpoint_factory = EndpointFactory::new();
        let server = endpoint_factory.endpoint();
        let server_address = server.local_addr().unwrap();
        let client = endpoint_factory.endpoint();

        let server_task = tokio::spawn(async move {
            let conn = server.accept().await.unwrap().await.unwrap();
            let mut stream = conn.accept_uni().await.unwrap();

            // read "hello"
            let mut buf = [0u8; 5];
            stream.read_exact(&mut buf).await.unwrap();

            let (waker, wake_counter) = new_count_waker();
            let mut cx = Context::from_waker(&waker);
            // do a blocking read which will add the stream in conn.blocked_readers
            {
                let mut buf = [0u8; 64];
                let read_fut = stream.read(&mut buf);
                tokio::pin!(read_fut);
                assert!(matches!(read_fut.as_mut().poll(&mut cx), Poll::Pending));
            }

            if !drop_stream {
                assert_eq!(wake_counter.wakes(), 0);
                // We have a blocked reader, closing the connection should wake it. We use this as
                // a proxy to assert that the stream is in conn.blocked_readers.
                conn.close(0u32.into(), b"done");
                assert_eq!(wake_counter.wakes(), 1);
            } else {
                // dropping the stream should remove it from conn.blocked_readers, so we don't
                // expect any wakeups
                drop(stream);
                assert_eq!(wake_counter.wakes(), 0, "no wakeups should have occurred");
                conn.close(0u32.into(), b"done");
                assert_eq!(wake_counter.wakes(), 0, "no wakeups should have occurred");
            }
        });

        let conn = client
            .connect(server_address, "localhost")
            .unwrap()
            .await
            .unwrap();
        let mut stream = conn.open_uni().await.unwrap();
        // need to send some data to actually start the stream
        stream.write_all(b"hello").await.unwrap();

        server_task.await.unwrap();
    }
}

/// Test that dropping a `RecvStream` after cancelling a read and then
/// explicitly `stop`ing it doesn't panic.
#[tokio::test]
async fn recv_stream_cancel_stop_drop() {
    let _guard = subscribe();
    let factory = EndpointFactory::new();
    let server = {
        let _guard = error_span!("server").entered();
        factory.endpoint()
    };
    let server_addr = server.local_addr().unwrap();

    let client = {
        let _guard = error_span!("client").entered();
        factory.endpoint()
    };
    let recv_dropped = tokio::sync::SetOnce::new();
    join!(
        async {
            let conn = server.accept().await.unwrap().await.unwrap();
            let mut recv = conn.accept_uni().await.unwrap();
            // Create a future to read from the stream, poll it once, then immediately drop it
            {
                let fut = pin!(recv.read_to_end(usize::MAX));
                let mut cx = Context::from_waker(Waker::noop());
                assert!(fut.poll(&mut cx).is_pending());
            }
            recv_dropped.set(()).unwrap();
            recv.stop(0u32.into()).unwrap();
        },
        async {
            let conn = client
                .connect(server_addr, "localhost")
                .unwrap()
                .await
                .unwrap();
            let mut send = conn.open_uni().await.unwrap();
            _ = send.write_all(b"hello").await;
            // Don't drop (finish) the send stream until the read has been
            // cancelled by the server, ensuring that read_to_end can't complete
            // immediately.
            recv_dropped.wait().await;
        },
    );
}

#[derive(Default)]
struct WakeCounter {
    wakes: AtomicUsize,
}

impl WakeCounter {
    fn wakes(&self) -> usize {
        self.wakes.load(Ordering::SeqCst)
    }
}

fn new_count_waker() -> (Waker, Arc<WakeCounter>) {
    // instance of WakeCounter
    let counter = Arc::new(WakeCounter::default());

    // convert
    let waker = unsafe { Waker::from_raw(raw_waker(counter.clone())) };
    (waker, counter)
}

fn raw_waker(counter: Arc<WakeCounter>) -> RawWaker {
    // Store an Arc<WakeCounter> behind the raw pointer.
    let ptr = Arc::into_raw(counter) as *const ();
    RawWaker::new(ptr, &VTABLE)
}

static VTABLE: RawWakerVTable =
    RawWakerVTable::new(clone_waker, wake_waker, wake_by_ref_waker, drop_waker);

unsafe fn clone_waker(data: *const ()) -> RawWaker {
    let arc = Arc::<WakeCounter>::from_raw(data as *const WakeCounter);
    let cloned = arc.clone();
    std::mem::forget(arc);
    raw_waker(cloned)
}

unsafe fn wake_waker(data: *const ()) {
    let arc = Arc::<WakeCounter>::from_raw(data as *const WakeCounter);
    arc.wakes.fetch_add(1, Ordering::SeqCst);
    // arc drops here
}

unsafe fn wake_by_ref_waker(data: *const ()) {
    let arc = Arc::<WakeCounter>::from_raw(data as *const WakeCounter);
    arc.wakes.fetch_add(1, Ordering::SeqCst);
    std::mem::forget(arc);
}

unsafe fn drop_waker(data: *const ()) {
    drop(Arc::<WakeCounter>::from_raw(data as *const WakeCounter));
}

/// Merkur's patch: the connection driver hands transmits to the socket outside the connection's
/// state lock, and the delivery view readers take without that lock equals the state at every
/// release of it.
mod driver_io {
    use super::*;
    use crate::{AsyncUdpSocket, Connection, Runtime as _, UdpPoller, VarInt};
    use std::io::IoSliceMut;
    use std::pin::Pin;
    use std::sync::{Mutex, atomic::AtomicBool, mpsc};

    /// The client's UDP socket, checking every transmit the moment the driver offers it: the
    /// state lock must be free, the lock-free view must equal what a lock holder computes, and
    /// a transmit the socket refused must be the next one offered.
    #[derive(Debug)]
    struct Watched {
        inner: Arc<dyn AsyncUdpSocket>,
        connection: Mutex<Option<Connection>>,
        /// Refuse every this many offers, 0 for none, reporting the socket unwritable once so the
        /// driver keeps the transmit across a poll
        refuse_every: AtomicUsize,
        offers: AtomicUsize,
        unwritable_once: AtomicBool,
        refused: Mutex<Option<Vec<u8>>>,
        refusals: AtomicUsize,
        sent_datagrams: AtomicUsize,
        under_lock: AtomicUsize,
        stale_views: AtomicUsize,
        out_of_order: AtomicUsize,
    }

    impl Watched {
        fn bind(refuse_every: usize) -> Arc<Self> {
            let socket = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
                .expect("bind");
            Arc::new(Self {
                inner: TokioRuntime.wrap_udp_socket(socket).expect("wrap"),
                connection: Mutex::new(None),
                refuse_every: AtomicUsize::new(refuse_every),
                offers: AtomicUsize::new(0),
                unwritable_once: AtomicBool::new(false),
                refused: Mutex::new(None),
                refusals: AtomicUsize::new(0),
                sent_datagrams: AtomicUsize::new(0),
                under_lock: AtomicUsize::new(0),
                stale_views: AtomicUsize::new(0),
                out_of_order: AtomicUsize::new(0),
            })
        }

        fn watch(&self, connection: &Connection) {
            *self.connection.lock().unwrap() = Some(connection.clone());
        }

        /// Stop checking and refusing; the watched connection may close
        fn release(&self) {
            self.refuse_every.store(0, Ordering::Relaxed);
            self.connection.lock().unwrap().take();
        }

        fn count(counter: &AtomicUsize) -> usize {
            counter.load(Ordering::Relaxed)
        }
    }

    impl AsyncUdpSocket for Watched {
        fn create_io_poller(self: Arc<Self>) -> Pin<Box<dyn UdpPoller>> {
            Box::pin(WatchedPoller {
                inner: self.inner.clone().create_io_poller(),
                socket: self,
            })
        }

        fn try_send(&self, transmit: &udp::Transmit) -> io::Result<()> {
            if let Some(connection) = self.connection.lock().unwrap().as_ref() {
                if connection.state_is_locked() {
                    self.under_lock.fetch_add(1, Ordering::Relaxed);
                } else {
                    // The view first: this check's own release of the lock publishes.
                    let view = connection.delivery_state();
                    if view != connection.locked_delivery_state() {
                        self.stale_views.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            let offer = self.offers.fetch_add(1, Ordering::Relaxed) + 1;
            let refuse_every = self.refuse_every.load(Ordering::Relaxed);
            if refuse_every != 0 && offer % refuse_every == 0 {
                *self.refused.lock().unwrap() = Some(transmit.contents.to_vec());
                self.refusals.fetch_add(1, Ordering::Relaxed);
                self.unwritable_once.store(true, Ordering::Relaxed);
                return Err(io::ErrorKind::WouldBlock.into());
            }
            let refused = self.refused.lock().unwrap().take();
            if refused.is_some_and(|refused| refused != transmit.contents) {
                self.out_of_order.fetch_add(1, Ordering::Relaxed);
            }
            self.inner.try_send(transmit)?;
            let datagrams = match transmit.segment_size {
                None => 1,
                Some(size) => transmit.contents.len().div_ceil(size),
            };
            self.sent_datagrams.fetch_add(datagrams, Ordering::Relaxed);
            Ok(())
        }

        fn poll_recv(
            &self,
            cx: &mut Context,
            bufs: &mut [IoSliceMut<'_>],
            meta: &mut [udp::RecvMeta],
        ) -> Poll<io::Result<usize>> {
            self.inner.poll_recv(cx, bufs, meta)
        }

        fn local_addr(&self) -> io::Result<SocketAddr> {
            self.inner.local_addr()
        }

        fn max_transmit_segments(&self) -> usize {
            self.inner.max_transmit_segments()
        }

        fn max_receive_segments(&self) -> usize {
            self.inner.max_receive_segments()
        }

        fn may_fragment(&self) -> bool {
            self.inner.may_fragment()
        }
    }

    #[derive(Debug)]
    struct WatchedPoller {
        inner: Pin<Box<dyn UdpPoller>>,
        socket: Arc<Watched>,
    }

    impl UdpPoller for WatchedPoller {
        fn poll_writable(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<io::Result<()>> {
            if self.socket.unwritable_once.swap(false, Ordering::Relaxed) {
                // Writable again at once; the driver must keep the refused transmit until then.
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            self.inner.as_mut().poll_writable(cx)
        }
    }

    fn endpoint_on(factory: &EndpointFactory, socket: Arc<dyn AsyncUdpSocket>) -> Endpoint {
        let key = PrivateKeyDer::Pkcs8(factory.cert.signing_key.serialize_der().into());
        let server_config =
            crate::ServerConfig::with_single_cert(vec![factory.cert.cert.der().clone()], key)
                .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(factory.cert.cert.der().clone()).unwrap();
        let mut endpoint = Endpoint::new_with_abstract_socket(
            factory.endpoint_config.clone(),
            Some(server_config),
            socket,
            Arc::new(TokioRuntime),
        )
        .unwrap();
        endpoint.set_default_client_config(
            ClientConfig::with_root_certificates(Arc::new(roots)).unwrap(),
        );
        endpoint
    }

    async fn connect(client: &Endpoint, server: &Endpoint) -> (Connection, Connection) {
        let server_addr = server.local_addr().unwrap();
        join!(
            async {
                client
                    .connect(server_addr, "localhost")
                    .unwrap()
                    .await
                    .expect("connect")
            },
            async {
                server
                    .accept()
                    .await
                    .expect("incoming")
                    .await
                    .expect("accept")
            },
        )
    }

    /// Client-to-server stream of `len` bytes, read back whole
    async fn transfer(client: &Connection, server: &Connection, len: usize, seed: u64) {
        let payload = gen_data(len, seed);
        let (_, received) = join!(
            async {
                let mut stream = client.open_uni().await.unwrap();
                stream.write_all(&payload).await.unwrap();
                stream.finish().unwrap();
                let _ = stream.stopped().await;
            },
            async {
                let mut stream = server.accept_uni().await.unwrap();
                stream.read_to_end(usize::MAX).await.unwrap()
            },
        );
        assert_eq!(received, payload);
    }

    #[test]
    fn transmits_leave_outside_the_state_lock_in_build_order_with_an_exact_view() {
        let _guard = subscribe();
        let runtime = rt_basic();
        runtime.block_on(async {
            let factory = EndpointFactory::new();
            let server = factory.endpoint();
            let socket = Watched::bind(7);
            let client = endpoint_on(&factory, socket.clone());
            let (client_connection, server_connection) = connect(&client, &server).await;
            socket.watch(&client_connection);
            transfer(&client_connection, &server_connection, 1 << 20, 11).await;
            socket.release();
            // Let the last acknowledgments leave: every datagram built is then sent.
            sleep(Duration::from_millis(50)).await;

            assert!(Watched::count(&socket.refusals) > 0, "no transmit was refused");
            assert_eq!(
                Watched::count(&socket.under_lock),
                0,
                "a transmit was offered while the state lock was held"
            );
            assert_eq!(
                Watched::count(&socket.stale_views),
                0,
                "the view differed from the state at a release"
            );
            assert_eq!(
                Watched::count(&socket.out_of_order),
                0,
                "a transmit overtook one the socket refused"
            );
            assert_eq!(
                Watched::count(&socket.sent_datagrams) as u64,
                client_connection.stats().udp_tx.datagrams,
                "a built datagram never left"
            );
        });
    }

    #[test]
    fn a_rebind_moves_every_later_transmit_to_the_new_socket() {
        let _guard = subscribe();
        let runtime = rt_basic();
        runtime.block_on(async {
            let factory = EndpointFactory::new();
            let server = factory.endpoint();
            let replaced = Watched::bind(0);
            let client = endpoint_on(&factory, replaced.clone());
            let (client_connection, server_connection) = connect(&client, &server).await;
            transfer(&client_connection, &server_connection, 64 * 1024, 12).await;

            let fresh = Watched::bind(0);
            client.rebind_abstract(fresh.clone()).unwrap();
            let before = Watched::count(&replaced.sent_datagrams);
            transfer(&client_connection, &server_connection, 64 * 1024, 13).await;

            assert_eq!(
                Watched::count(&replaced.sent_datagrams),
                before,
                "a transmit left through the replaced socket"
            );
            assert!(Watched::count(&fresh.sent_datagrams) > 0);
        });
    }

    #[test]
    fn delivery_view_closure_and_egress_group_read_while_another_thread_holds_the_lock() {
        let _guard = subscribe();
        let runtime = rt_basic();
        let (client_connection, _server_connection, _endpoints) = runtime.block_on(async {
            let factory = EndpointFactory::new();
            let server = factory.endpoint();
            let client = factory.endpoint();
            let (client_connection, server_connection) = connect(&client, &server).await;
            (client_connection, server_connection, (client, server))
        });
        let expected = client_connection.locked_delivery_state();
        let read = client_connection.while_state_locked(|| {
            let connection = client_connection.clone();
            let (sender, receiver) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = sender.send((
                    connection.delivery_state(),
                    connection.is_closed(),
                    connection.egress_group().is_none(),
                ));
            });
            receiver.recv_timeout(Duration::from_secs(5))
        });
        assert_eq!(read, Ok((expected, false, true)));
    }

    #[test]
    fn a_datagram_admission_publishes_its_room_before_the_lock_is_released() {
        let _guard = subscribe();
        let runtime = rt_basic();
        runtime.block_on(async {
            let factory = EndpointFactory::new();
            let server = factory.endpoint();
            let client = factory.endpoint();
            let (client_connection, _server_connection) = connect(&client, &server).await;
            let before = client_connection.delivery_state();
            assert!(
                client_connection
                    .try_send_datagram_with_prefix(
                        VarInt::from_u32(5),
                        Bytes::from_static(&[7; 100])
                    )
                    .unwrap()
            );
            // No await since: the driver has not run, so the datagram is still queued.
            let after = client_connection.delivery_state();
            assert_eq!(after, client_connection.locked_delivery_state());
            assert_eq!(
                before.datagram_send_buffer_space - after.datagram_send_buffer_space,
                101 + proto::DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD
            );
        });
    }

    #[test]
    fn only_an_observed_thread_is_charged_and_only_for_a_contended_acquisition() {
        let _guard = subscribe();
        let runtime = rt_basic();
        let (connection, _server_connection, _endpoints) = runtime.block_on(async {
            let factory = EndpointFactory::new();
            let server = factory.endpoint();
            let client = factory.endpoint();
            let (client_connection, server_connection) = connect(&client, &server).await;
            (client_connection, server_connection, (client, server))
        });
        // Nothing drives the runtime from here, so the test's threads are the only holders.
        let charged = |connection: Connection, observed: bool, acquisitions: usize| {
            std::thread::spawn(move || {
                crate::contention::observe(observed);
                let before = crate::contention::waited();
                for _ in 0..acquisitions {
                    let _ = connection.stats();
                }
                crate::contention::waited() - before
            })
            .join()
            .unwrap()
        };
        // Enough uncontended acquisitions that timing them would register on a 42 ns clock.
        assert_eq!(charged(connection.clone(), true, 10_000), Duration::ZERO);

        const HOLD: Duration = Duration::from_millis(30);
        for observed in [true, false] {
            let (locked, is_locked) = mpsc::channel();
            let holder = {
                let connection = connection.clone();
                std::thread::spawn(move || {
                    connection.while_state_locked(|| {
                        locked.send(()).unwrap();
                        std::thread::sleep(HOLD);
                    })
                })
            };
            is_locked.recv().unwrap();
            let waited = charged(connection.clone(), observed, 1);
            holder.join().unwrap();
            if observed {
                assert!(waited >= HOLD / 2, "observed wait {waited:?}");
            } else {
                assert_eq!(waited, Duration::ZERO);
            }
        }
    }

    /// Manual measurement, in release mode: while a 16 MiB stream written in
    /// 16 KiB chunks (as the daemon writes a tile) saturates a loopback
    /// connection, a foreign "owner" thread admits a small datagram every 50 µs
    /// (each takes the state lock, as the daemon owner's sends do) and reads the
    /// delivery view, recording the wait of each contended admission. Prints
    /// one line.
    #[test]
    #[ignore = "manual release-mode measurement"]
    fn owner_waits_during_a_bulk_transfer() {
        let runtime = rt_threaded();
        let (client_connection, server_connection, _endpoints) = runtime.block_on(async {
            let factory = EndpointFactory::new();
            let server = factory.endpoint();
            let client = factory.endpoint();
            let (client_connection, server_connection) = connect(&client, &server).await;
            (client_connection, server_connection, (client, server))
        });
        let stop = Arc::new(AtomicBool::new(false));
        let owner = {
            let connection = client_connection.clone();
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                crate::contention::observe(true);
                let mut waits = Vec::new();
                let mut view_reads = 0_u64;
                while !stop.load(Ordering::Relaxed) {
                    let before = crate::contention::waited();
                    let _ = connection
                        .try_send_datagram_with_prefix(VarInt::from_u32(1), Bytes::from_static(&[0; 32]));
                    waits.push((crate::contention::waited() - before).as_nanos() as u64);
                    view_reads += connection.delivery_state().bytes_in_flight.min(1);
                    let next = Instant::now() + Duration::from_micros(50);
                    while Instant::now() < next {
                        std::hint::spin_loop();
                    }
                }
                (waits, view_reads)
            })
        };
        let started = Instant::now();
        runtime.block_on(async {
            let payload = gen_data(16 << 20, 21);
            let (_, received) = join!(
                async {
                    let mut stream = client_connection.open_uni().await.unwrap();
                    for chunk in payload.chunks(16 * 1024) {
                        stream.write_all(chunk).await.unwrap();
                    }
                    stream.finish().unwrap();
                    let _ = stream.stopped().await;
                },
                async {
                    let mut stream = server_connection.accept_uni().await.unwrap();
                    stream.read_to_end(usize::MAX).await.unwrap()
                },
            );
            assert_eq!(received.len(), payload.len());
        });
        let transfer = started.elapsed();
        stop.store(true, Ordering::Relaxed);
        let (mut waits, _) = owner.join().unwrap();
        let acquisitions = waits.len();
        waits.retain(|wait| *wait > 0);
        waits.sort_unstable();
        let rank = |q: f64| {
            waits
                .get(((waits.len() as f64 * q).ceil() as usize).saturating_sub(1))
                .map_or(0.0, |ns| *ns as f64 / 1_000.0)
        };
        println!(
            "owner-wait: acquisitions={acquisitions} contended={} p50_us={:.1} p99_us={:.1} max_us={:.1} total_ms={:.2} transfer_ms={:.1}",
            waits.len(),
            rank(0.5),
            rank(0.99),
            rank(1.0),
            waits.iter().sum::<u64>() as f64 / 1e6,
            transfer.as_secs_f64() * 1e3,
        );
    }

    /// A connected pair with nothing in flight and every handshake acknowledgment sent, so any
    /// packet the client builds afterwards is one the test asked for.
    async fn settled_pair(
        factory: &EndpointFactory,
        socket: Arc<Watched>,
    ) -> (Connection, Connection, Endpoint, Endpoint) {
        let server = factory.endpoint();
        let client = endpoint_on(factory, socket);
        let (client_connection, server_connection) = connect(&client, &server).await;
        super::eventually(Duration::from_secs(10), || {
            client_connection.stats().path.bytes_in_flight == 0
                && server_connection.stats().path.bytes_in_flight == 0
        })
        .await;
        // The peers' delayed acknowledgments leave within their maximum ACK delay.
        sleep(Duration::from_millis(60)).await;
        (client_connection, server_connection, client, server)
    }

    fn datagram(fill: u8, len: usize) -> Bytes {
        Bytes::from(vec![fill; len])
    }

    #[test]
    fn datagrams_admitted_under_a_hold_leave_in_one_packet_when_it_is_released() {
        let _guard = subscribe();
        // Threaded, so the driver is free to run on another worker between admissions.
        let runtime = rt_threaded();
        runtime.block_on(async {
            let factory = EndpointFactory::new();
            let socket = Watched::bind(0);
            let (client_connection, server_connection, _client, _server) =
                settled_pair(&factory, socket.clone()).await;
            let sent_before = Watched::count(&socket.sent_datagrams);
            let hold = client_connection.hold_egress();
            for fill in 0..3 {
                assert!(
                    client_connection
                        .try_send_datagram_with_prefix(VarInt::from_u32(0), datagram(fill, 40))
                        .unwrap()
                );
                sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(
                Watched::count(&socket.sent_datagrams),
                sent_before,
                "a packet was built while the hold was live"
            );
            drop(hold);

            let mut received: [Bytes; 8] = Default::default();
            let count = timeout(
                Duration::from_secs(5),
                server_connection.read_datagrams(&mut received, 1500),
            )
            .await
            .expect("the release wakes the driver")
            .unwrap();
            assert_eq!(count, 3, "one packet's datagrams are read together");
            for (fill, payload) in received[..count].iter().enumerate() {
                assert_eq!(payload[1..], [fill as u8; 40]);
            }
            assert_eq!(
                Watched::count(&socket.sent_datagrams),
                sent_before + 1,
                "the held datagrams did not share one packet"
            );
        });
    }

    #[test]
    fn nested_holds_build_nothing_until_the_last_is_released() {
        let _guard = subscribe();
        let runtime = rt_threaded();
        runtime.block_on(async {
            let factory = EndpointFactory::new();
            let socket = Watched::bind(0);
            let (client_connection, server_connection, _client, _server) =
                settled_pair(&factory, socket.clone()).await;
            let sent_before = Watched::count(&socket.sent_datagrams);
            let outer = client_connection.hold_egress();
            let inner = client_connection.hold_egress();
            assert!(
                client_connection
                    .try_send_datagram_with_prefix(VarInt::from_u32(0), datagram(9, 40))
                    .unwrap()
            );
            sleep(Duration::from_millis(20)).await;
            drop(inner);
            sleep(Duration::from_millis(20)).await;
            assert_eq!(
                Watched::count(&socket.sent_datagrams),
                sent_before,
                "an inner release let the driver build"
            );
            drop(outer);
            let mut received: [Bytes; 1] = Default::default();
            timeout(
                Duration::from_secs(5),
                server_connection.read_datagrams(&mut received, 1500),
            )
            .await
            .expect("the last release wakes the driver")
            .unwrap();
            assert_eq!(received[0][1..], [9; 40]);
        });
    }

    #[test]
    fn a_hold_blocks_neither_admission_nor_the_published_view() {
        let _guard = subscribe();
        let runtime = rt_basic();
        runtime.block_on(async {
            let factory = EndpointFactory::new();
            let server = factory.endpoint();
            let client = factory.endpoint();
            let (client_connection, _server_connection) = connect(&client, &server).await;
            let before = client_connection.delivery_state();
            let _hold = client_connection.hold_egress();
            assert!(
                client_connection
                    .try_send_datagram_with_prefix(VarInt::from_u32(5), datagram(7, 100))
                    .unwrap()
            );
            let after = client_connection.delivery_state();
            assert_eq!(after, client_connection.locked_delivery_state());
            assert_eq!(
                before.datagram_send_buffer_space - after.datagram_send_buffer_space,
                101 + proto::DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD
            );
        });
    }

    #[test]
    fn a_batched_read_takes_the_first_datagram_whole_then_only_what_fits() {
        let _guard = subscribe();
        let runtime = rt_threaded();
        runtime.block_on(async {
            let factory = EndpointFactory::new();
            let (client_connection, server_connection, _client, _server) =
                settled_pair(&factory, Watched::bind(0)).await;
            {
                let _hold = client_connection.hold_egress();
                for (fill, len) in [(1, 200), (2, 300), (3, 400)] {
                    assert!(
                        client_connection
                            .try_send_datagram_with_prefix(VarInt::from_u32(0), datagram(fill, len))
                            .unwrap()
                    );
                }
            }
            let mut received: [Bytes; 8] = Default::default();
            // The first is taken whatever its size; the second would exceed the bound.
            let first = timeout(
                Duration::from_secs(5),
                server_connection.read_datagrams(&mut received, 150),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!((first, received[0].len()), (1, 201));
            // The slice bounds the count.
            let second = server_connection
                .read_datagrams(&mut received[..1], 1500)
                .await
                .unwrap();
            assert_eq!((second, received[0].len()), (1, 301));
            let third = server_connection
                .read_datagrams(&mut received, 1500)
                .await
                .unwrap();
            assert_eq!((third, received[0].len()), (1, 401));
        });
    }
}

/// A socket whose sends vanish while `dark`: an outage of its host's outbound path.
#[derive(Debug)]
struct DarkSocket {
    inner: Arc<dyn crate::AsyncUdpSocket>,
    dark: Arc<std::sync::atomic::AtomicBool>,
}

impl crate::AsyncUdpSocket for DarkSocket {
    fn create_io_poller(self: Arc<Self>) -> std::pin::Pin<Box<dyn crate::UdpPoller>> {
        self.inner.clone().create_io_poller()
    }

    fn try_send(&self, transmit: &udp::Transmit) -> io::Result<()> {
        if self.dark.load(Ordering::Acquire) {
            return Ok(());
        }
        self.inner.try_send(transmit)
    }

    fn poll_recv(
        &self,
        cx: &mut Context,
        bufs: &mut [io::IoSliceMut<'_>],
        meta: &mut [udp::RecvMeta],
    ) -> Poll<io::Result<usize>> {
        self.inner.poll_recv(cx, bufs, meta)
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.local_addr()
    }

    fn max_transmit_segments(&self) -> usize {
        self.inner.max_transmit_segments()
    }

    fn max_receive_segments(&self) -> usize {
        self.inner.max_receive_segments()
    }

    fn may_fragment(&self) -> bool {
        self.inner.may_fragment()
    }
}

impl EndpointFactory {
    /// A server whose outbound path goes dark while the returned flag is set.
    fn dark_server(&self) -> (Endpoint, Arc<std::sync::atomic::AtomicBool>) {
        let key = PrivateKeyDer::Pkcs8(self.cert.signing_key.serialize_der().into());
        let server_config =
            crate::ServerConfig::with_single_cert(vec![self.cert.cert.der().clone()], key).unwrap();
        let dark = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let runtime = Arc::new(TokioRuntime);
        let socket = crate::Runtime::wrap_udp_socket(
            &*runtime,
            UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap(),
        )
        .unwrap();
        let endpoint = Endpoint::new_with_abstract_socket(
            self.endpoint_config.clone(),
            Some(server_config),
            Arc::new(DarkSocket {
                inner: socket,
                dark: dark.clone(),
            }),
            runtime,
        )
        .unwrap();
        (endpoint, dark)
    }
}

/// One connection from `client` to `server`, as both ends see it.
async fn dark_pair(server: &Endpoint, client: &Endpoint) -> (crate::Connection, crate::Connection) {
    let address = server.local_addr().unwrap();
    join!(
        async { server.accept().await.unwrap().await.unwrap() },
        async { client.connect(address, "localhost").unwrap().await.unwrap() },
    )
}

/// Poll `condition` until it holds, failing after `limit`.
async fn eventually(limit: Duration, mut condition: impl FnMut() -> bool) {
    timeout(limit, async {
        while !condition() {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("condition did not hold in time");
}

#[tokio::test]
async fn the_driver_republishes_send_blocked_on_each_change_and_only_then() {
    let _guard = subscribe();
    let factory = EndpointFactory::new();
    let (server, dark) = factory.dark_server();
    let client = factory.endpoint();
    let (accepted, connected) = dark_pair(&server, &client).await;
    let mut blocked = accepted.send_blocked();
    assert!(!*blocked.borrow_and_update());

    dark.store(true, Ordering::Release);
    let mut send = accepted.open_uni().await.unwrap();
    send.write_all(&[0x5a; 256 * 1024]).await.unwrap();
    timeout(Duration::from_secs(10), blocked.changed())
        .await
        .expect("a dark path with a full window must block")
        .unwrap();
    assert!(*blocked.borrow_and_update());
    // Further expiries back the timer off without republishing anything.
    let backoff = accepted.stats().path.pto_count;
    eventually(Duration::from_secs(10), || {
        accepted.stats().path.pto_count > backoff
    })
    .await;
    assert!(!blocked.has_changed().unwrap());

    dark.store(false, Ordering::Release);
    connected.ping();
    timeout(Duration::from_secs(10), blocked.changed())
        .await
        .expect("the probe's acknowledgment must unblock")
        .unwrap();
    assert!(!*blocked.borrow_and_update());
}

#[tokio::test]
async fn a_packet_one_connection_hears_wakes_its_backed_off_sibling() {
    let _guard = subscribe();
    let factory = EndpointFactory::new();
    let (server, dark) = factory.dark_server();
    let client = factory.endpoint();
    let (heard, heard_client) = dark_pair(&server, &client).await;
    let (waiting, waiting_client) = dark_pair(&server, &client).await;
    let group = crate::ProbeGroup::new();
    heard.join_probe_group(&group).unwrap();
    waiting.join_probe_group(&group).unwrap();
    // Settled first: nothing in flight anywhere, so no probe of a client's
    // own can reach the waiting connection and reopen it by itself.
    let ends = [&heard, &heard_client, &waiting, &waiting_client];
    eventually(Duration::from_secs(10), || {
        ends.iter().all(|end| end.stats().path.bytes_in_flight == 0)
    })
    .await;

    let mut send = waiting.open_uni().await.unwrap();
    dark.store(true, Ordering::Release);
    send.write_all(&[0x5a; 1000]).await.unwrap();
    eventually(Duration::from_secs(10), || {
        waiting.stats().path.pto_count >= 3
    })
    .await;
    let own_probe = waiting
        .stats()
        .path
        .loss_detection_deadline
        .expect("the backed-off probe timer is armed");
    dark.store(false, Ordering::Release);

    let healed = Instant::now();
    heard_client.ping();
    eventually(Duration::from_secs(10), || {
        waiting.stats().path.pto_count == 0
    })
    .await;
    assert!(
        Instant::now() < own_probe,
        "the sibling waited for its own backed-off probe timer: recovered after {:?}, its \
         timer was {:?} away",
        healed.elapsed(),
        own_probe.saturating_duration_since(healed)
    );
}
