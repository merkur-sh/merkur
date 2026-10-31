use super::tests::{attach_test_peer, read_test_lifecycle};
use super::*;
use wtransport::endpoint::endpoint_side::Client;
use wtransport::{ClientConfig, Endpoint};

fn endpoints() -> (Endpoint<Server>, Endpoint<Client>, String) {
    crate::install_crypto_provider();
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
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(cert.cert_hash)])
            .build(),
    )
    .unwrap();
    let url = format!("https://{}", server.local_addr().unwrap());
    (server, client, url)
}

struct Relay {
    client: Endpoint<Client>,
    url: String,
    accept_task: tokio::task::JoinHandle<()>,
}

impl Relay {
    fn new() -> Self {
        let (server, client, url) = endpoints();
        let accept_task = tokio::spawn(accept_loop(
            Arc::new(server),
            SpliceRegistry::new(),
            crate::attach_ticket::test_key(),
            crate::egress_budget::test_open_budget(),
        ));
        Self {
            client,
            url,
            accept_task,
        }
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

#[tokio::test]
async fn retired_source_termination_cost() {
    for reset in [false, true] {
        termination_cost(reset).await;
    }
}

async fn termination_cost(reset: bool) {
    let (server, client, url) = endpoints();
    let accept = async { server.accept().await.await.unwrap().accept().await.unwrap() };
    let (edge, peer) = tokio::join!(accept, client.connect(&url));
    let peer = peer.unwrap();
    let mut send = edge.open_uni().await.unwrap().await.unwrap();
    send.write_all(&[0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 1, 42])
        .await
        .unwrap();
    let mut recv = peer.accept_uni().await.unwrap();
    let mut bytes = [0; 14];
    recv.read_exact(&mut bytes).await.unwrap();
    assert_eq!(bytes[13], 42);
    send.quic_stream().drained().await;
    let before = edge.quic_connection().stats();
    if reset {
        // WebTransport application code 1 mapped into HTTP/3's reserved range.
        send.reset(VarInt::try_from_u64(0x52e4_a40f_a8dc).unwrap())
            .unwrap();
    }
    drop(send);
    let ended = recv.read(&mut [0; 1]).await;
    if reset {
        assert!(ended.is_err());
    } else {
        assert_eq!(ended.unwrap(), None);
    }
    let after = edge.quic_connection().stats();
    assert!(peer.quic_connection().close_reason().is_none());
    println!(
        "reset={reset} stream_frames={} reset_frames={} udp_bytes={} udp_packets={} carrier_closes=0 payload_bytes=1",
        after.frame_tx.stream - before.frame_tx.stream,
        after.frame_tx.reset_stream - before.frame_tx.reset_stream,
        after.udp_tx.bytes - before.udp_tx.bytes,
        after.udp_tx.datagrams - before.udp_tx.datagrams
    );
}

#[tokio::test]
async fn retired_source_does_not_close_successor_carrier() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let relay = Relay::new();
        let mut retired = 0;
        for phase in ["idle", "header", "body"] {
            for close in [false, true] {
                retired += usize::from(retire_source(&relay, phase, close).await);
            }
        }
        println!("retired_source cases=6 retirement_resets={retired} successor_records=12 payload_bytes=12 carrier_closes=0");
        assert_eq!(retired, 6);
    })
    .await
    .expect("bounded source retirement");
}

async fn retire_source(relay: &Relay, phase: &str, close: bool) -> bool {
    let session = format!("retired-source-{phase}-{close}");
    let (old, _old_send, mut old_control, _old_quote) =
        attach_test_peer(&relay.client, &relay.url, &session, Role::Daemon).await;
    read_test_lifecycle(&mut old_control).await;
    let (browser, _browser_send, mut browser_control, _) =
        attach_test_peer(&relay.client, &relay.url, &session, Role::Browser).await;
    read_test_lifecycle(&mut browser_control).await;
    let mut old_send = old.open_uni().await.unwrap().await.unwrap();
    old_send.write_all(&[2, 0, 0, 0, 1, 41]).await.unwrap();
    let mut old_recv = browser.accept_uni().await.unwrap();
    let mut first = [0; 14];
    old_recv.read_exact(&mut first).await.unwrap();
    assert_eq!(&first[8..], &[2, 0, 0, 0, 1, 41]);
    match phase {
        "header" => old_send.write_all(&[0, 0]).await.unwrap(),
        "body" => {
            old_send.write_all(&[0, 0, 0, 2, 99]).await.unwrap();
            old_recv.read_exact(&mut [0; 5]).await.unwrap();
        }
        _ => (),
    }
    if close {
        old.close(VarInt::from_u32(0), b"retire-source");
    }
    let (successor, _successor_send, mut successor_control, _successor_quote) =
        attach_test_peer(&relay.client, &relay.url, &session, Role::Daemon).await;
    read_test_lifecycle(&mut successor_control).await;
    old.closed().await;
    let mut new_send = successor.open_uni().await.unwrap().await.unwrap();
    new_send.write_all(&[2, 0, 0, 0, 1, 42]).await.unwrap();
    let mut new_recv = browser.accept_uni().await.unwrap();
    let mut next = [0; 14];
    new_recv.read_exact(&mut next).await.unwrap();
    assert_eq!(&next[8..], &[2, 0, 0, 0, 1, 42]);
    assert_ne!(&first[..8], &next[..8]);
    let ended = old_recv.read(&mut [0; 1]).await;
    println!(
        "retired_source phase={phase} close={close} old_outcome={ended:?} successor_records=1 successor_payload_bytes=1 carrier_closes={}",
        usize::from(browser.quic_connection().close_reason().is_some())
    );
    let retired = matches!(ended, Err(wtransport::error::StreamReadError::Reset(code))
        if code.into_inner() == 0x52e4_a40f_a8dc);
    assert!(browser.quic_connection().close_reason().is_none());
    new_send.write_all(&[0, 0, 0, 1, 43]).await.unwrap();
    let mut continued = [0; 5];
    new_recv.read_exact(&mut continued).await.unwrap();
    assert_eq!(continued, [0, 0, 0, 1, 43]);
    browser.close(VarInt::from_u32(0), b"done");
    successor.close(VarInt::from_u32(0), b"done");
    retired
}

#[tokio::test]
async fn retired_source_active_faults_are_not_retirement() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let relay = Relay::new();
        for failure in [
            "fin",
            "header",
            "body",
            "reset",
            "forged-retirement",
            "oversize",
        ] {
            active_fault(&relay, failure).await;
        }
        println!("active_lane faults=6 retirement_resets=0 source_closes=6");
    })
    .await
    .expect("bounded active fault forwarding");
}

async fn active_fault(relay: &Relay, failure: &str) {
    let (daemon, _ds, mut dc, _dq) =
        attach_test_peer(&relay.client, &relay.url, failure, Role::Daemon).await;
    read_test_lifecycle(&mut dc).await;
    let (browser, _bs, mut bc, _) =
        attach_test_peer(&relay.client, &relay.url, failure, Role::Browser).await;
    read_test_lifecycle(&mut bc).await;
    let mut send = daemon.open_uni().await.unwrap().await.unwrap();
    send.write_all(&[2, 0, 0, 0, 1, 42]).await.unwrap();
    let mut recv = browser.accept_uni().await.unwrap();
    recv.read_exact(&mut [0; 14]).await.unwrap();
    match failure {
        "header" => send.write_all(&[0]).await.unwrap(),
        "body" => send.write_all(&[0, 0, 0, 2, 42]).await.unwrap(),
        "oversize" => send.write_all(&[0x7f, 0xff, 0xff, 0xff]).await.unwrap(),
        _ => (),
    }
    if failure == "reset" || failure == "forged-retirement" {
        let code = if failure == "reset" {
            7
        } else {
            0x52e4_a40f_a8dc
        };
        send.reset(VarInt::try_from_u64(code).unwrap()).unwrap();
    } else {
        send.quic_stream_mut().finish().unwrap();
    }
    // A live-lane fault remains EOF or a fault reset, never retirement.
    let mut buffer = [0; 32];
    loop {
        match recv.read(&mut buffer).await {
            Ok(Some(_)) => (),
            Ok(None) => break,
            Err(wtransport::error::StreamReadError::Reset(code)) => {
                assert_ne!(code.into_inner(), 0x52e4_a40f_a8dc, "{failure}");
                break;
            }
            Err(error) => panic!("unexpected destination error: {error}"),
        }
    }
    daemon.closed().await;
    browser.close(VarInt::from_u32(0), b"done");
}
