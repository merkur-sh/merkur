use super::*;
use crate::cert::EdgeCert;
use crate::endpoint_secret::EndpointSecret;
use crate::splice::{PREFACE_VERSION, Role, RoutingAttachment, RoutingPreface, SpliceRegistry};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use wtransport::endpoint::endpoint_side::Client;
use wtransport::{ClientConfig, Connection, RecvStream, SendStream};

struct Publication {
    body: Vec<u8>,
    answer: oneshot::Sender<u16>,
}

async fn publisher() -> (EdgePublisher, mpsc::Receiver<Publication>) {
    crate::install_crypto_provider();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (requests, receiver) = mpsc::channel(1);
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            assert_eq!(line, "POST /api/edge/register HTTP/1.1\r\n");
            let mut length = None;
            loop {
                line.clear();
                stream.read_line(&mut line).await.unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some((key, value)) = line.split_once(':')
                    && key.eq_ignore_ascii_case("content-length")
                {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
            }
            let mut body = vec![0; length.unwrap()];
            stream.read_exact(&mut body).await.unwrap();
            let (answer, response) = oneshot::channel();
            if requests.send(Publication { body, answer }).await.is_err() {
                return;
            }
            let Ok(status) = response.await else { return };
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    let publisher = EdgePublisher::new(
        format!("http://{address}/api/edge/register"),
        URL_SAFE_NO_PAD.encode([0x41_u8; REGISTRATION_KEY_BYTES]),
        "iad-1".into(),
        "iad".into(),
        "https://iad-1.edge.example:4433/".into(),
    )
    .unwrap();
    (publisher, receiver)
}

async fn attach(
    endpoint: &Endpoint<Client>,
    url: &str,
    role: Role,
) -> (
    Connection,
    SendStream,
    RecvStream,
    Option<(SendStream, RecvStream)>,
) {
    let connection = endpoint.connect(url).await.unwrap();
    let (mut send, recv) = connection.open_bi().await.unwrap().await.unwrap();
    let session_id = "registration-maintenance";
    let preface = serde_json::to_vec(&RoutingPreface {
        version: PREFACE_VERSION,
        session_id: session_id.into(),
        role,
        attachment: match role {
            Role::Browser => RoutingAttachment::Primary,
            Role::Daemon => RoutingAttachment::Tunnel {
                incarnation: "AAAAAAAAAAAAAAAAAAAAAA".into(),
            },
        },
        daemon_id: crate::attach_ticket::TEST_DAEMON_ID.into(),
        ticket: crate::attach_ticket::test_ticket(role.into(), session_id),
    })
    .unwrap();
    send.write_all(&(preface.len() as u32).to_be_bytes())
        .await
        .unwrap();
    send.write_all(&preface).await.unwrap();
    let quote = if role == Role::Daemon {
        let (mut send, recv) = connection.open_bi().await.unwrap().await.unwrap();
        send.write_all(b"merkur-edge-quote-v1").await.unwrap();
        Some((send, recv))
    } else {
        None
    };
    (connection, send, recv, quote)
}

#[tokio::test]
async fn registration_404_startup_waits_for_publication() {
    let (publisher, mut requests) = publisher().await;
    let hashes = ["served".into(), "next".into()];
    let initial = publisher.publish_initial(&hashes);
    tokio::pin!(initial);
    let first = tokio::select! {
        result = &mut initial => panic!("publication ended before response: {result:?}"),
        request = requests.recv() => request.unwrap(),
    };
    first.answer.send(404).unwrap();
    let second = tokio::select! {
        result = &mut initial => panic!("startup 404 must retry before admission: {result:?}"),
        request = requests.recv() => request.unwrap(),
    };
    assert_eq!(first.body, second.body);
    second.answer.send(200).unwrap();
    assert_eq!(initial.await, Ok(()));
    println!("startup: publications=2 identical_bodies=2 admitted_before_success=0");
}

#[tokio::test]
async fn registration_404_recovers_without_process_exit() {
    tokio::time::timeout(Duration::from_secs(90), live_registration_recovery())
        .await
        .expect("registration recovery must complete");
}

async fn live_registration_recovery() {
    let (publisher, mut requests) = publisher().await;
    let certs = EdgeCerts {
        active: EdgeCert::generate(&["localhost"]).unwrap(),
        next: EdgeCert::generate(&["localhost"]).unwrap(),
    };
    let hashes = certs.hashes_base64();
    let first = {
        let initial = publisher.publish_initial(&hashes);
        tokio::pin!(initial);
        let first = tokio::select! {
            result = &mut initial => panic!("initial publication ended: {result:?}"),
            request = requests.recv() => request.unwrap(),
        };
        first.answer.send(200).unwrap();
        assert_eq!(initial.await, Ok(()));
        first.body
    };
    let mut splice = live_splice(&certs).await;
    let address = splice.endpoint.local_addr().unwrap();
    let identities = (
        std::process::id(),
        splice.daemon.stable_id(),
        splice.browser.stable_id(),
    );

    let (trigger, rotation) = mpsc::channel(1);
    drop(trigger);
    let maintenance = run(
        splice.endpoint.clone(),
        "127.0.0.1:0".parse().unwrap(),
        vec!["localhost".into()],
        certs,
        publisher,
        rotation,
        PathBuf::new(),
    );
    tokio::pin!(maintenance);
    let missing = tokio::select! {
        result = &mut maintenance => panic!("maintenance ended: {result:?}"),
        request = requests.recv() => request.unwrap(),
    };
    assert_eq!(missing.body, first);
    missing.answer.send(404).unwrap();
    let recovered = tokio::select! {
        result = &mut maintenance => panic!("maintenance 404 must retain the endpoint: {result:?}"),
        request = forward_heartbeat(&mut splice, &mut requests) => request,
    };
    assert_eq!(recovered.body, first);
    recovered.answer.send(200).unwrap();
    // Reaching the following heartbeat proves maintenance accepted the recovery response.
    let next = tokio::select! {
        result = &mut maintenance => panic!("maintenance ended: {result:?}"),
        request = forward_heartbeat(&mut splice, &mut requests) => request,
    };
    assert_eq!(next.body, first);

    assert_eq!(
        identities,
        (
            std::process::id(),
            splice.daemon.stable_id(),
            splice.browser.stable_id()
        )
    );
    assert_eq!(splice.endpoint.local_addr().unwrap(), address);
    next.answer.send(401).unwrap();
    assert!(maintenance.await.unwrap_err().contains("401"));
    println!(
        "maintenance: publications=4 identical_bodies=4 carrier_replacements=0 records=61 payload_bytes=61 terminal_401=1"
    );
}

#[tokio::test]
async fn registration_terminal_rejections_do_not_retry() {
    for status in [400, 401, 403, 409] {
        let (publisher, mut requests) = publisher().await;
        let hashes = ["served".into(), "next".into()];
        let initial = publisher.publish_initial(&hashes);
        tokio::pin!(initial);
        let request = tokio::select! {
            result = &mut initial => panic!("publication ended: {result:?}"),
            request = requests.recv() => request.unwrap(),
        };
        request.answer.send(status).unwrap();
        assert!(initial.await.unwrap_err().contains(&status.to_string()));
        assert!(requests.try_recv().is_err());
        println!("terminal status={status}: publications=1 retries=0");
    }
}

struct LiveSplice {
    endpoint: Arc<Endpoint<Server>>,
    accept: tokio::task::JoinHandle<()>,
    _client: Endpoint<Client>,
    daemon: Connection,
    browser: Connection,
    _daemon_send: SendStream,
    _daemon_control: RecvStream,
    _quote: Option<(SendStream, RecvStream)>,
    _browser_send: SendStream,
    _browser_control: RecvStream,
    send: SendStream,
    recv: RecvStream,
}

impl Drop for LiveSplice {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

async fn live_splice(certs: &EdgeCerts) -> LiveSplice {
    let cert_hash = certs.active.cert_hash;
    let bind_addr = "127.0.0.1:0".parse().unwrap();
    let endpoint = Arc::new(
        relay::build_server(
            &certs.active,
            bind_addr,
            &EndpointSecret::generate().unwrap(),
        )
        .unwrap(),
    );
    let address = endpoint.local_addr().unwrap();
    let accept = tokio::spawn(relay::accept_loop(
        endpoint.clone(),
        SpliceRegistry::new(),
        crate::attach_ticket::test_key(),
        crate::egress_budget::test_open_budget(),
    ));
    let client = Endpoint::client(
        ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(cert_hash)])
            .build(),
    )
    .unwrap();
    let url = format!("https://127.0.0.1:{}", address.port());
    let (daemon, _daemon_send, _daemon_control, _quote) = attach(&client, &url, Role::Daemon).await;
    let (browser, _browser_send, _browser_control, _) = attach(&client, &url, Role::Browser).await;
    let mut send = daemon.open_uni().await.unwrap().await.unwrap();
    send.write_all(&[0x7a, 0, 0, 0, 1, 0x41]).await.unwrap();
    let mut recv = browser.accept_uni().await.unwrap();
    let mut prefix = [0; 9];
    recv.read_exact(&mut prefix).await.unwrap();
    assert_eq!(prefix[8], 0x7a);
    let mut record = [0; 5];
    recv.read_exact(&mut record).await.unwrap();
    assert_eq!(record, [0, 0, 0, 1, 0x41]);

    LiveSplice {
        endpoint,
        accept,
        _client: client,
        daemon,
        browser,
        _daemon_send,
        _daemon_control,
        _quote,
        _browser_send,
        _browser_control,
        send,
        recv,
    }
}

async fn forward_heartbeat(
    splice: &mut LiveSplice,
    requests: &mut mpsc::Receiver<Publication>,
) -> Publication {
    for _ in 0..30 {
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::time::resume();
        splice.send.write_all(&[0, 0, 0, 1, 0x42]).await.unwrap();
        let mut record = [0; 5];
        splice.recv.read_exact(&mut record).await.unwrap();
        assert_eq!(record, [0, 0, 0, 1, 0x42]);
    }
    requests.recv().await.unwrap()
}
