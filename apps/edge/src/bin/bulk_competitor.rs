//! merkur-edge-bulk-competitor — one long bulk flow that shares a harness link.
//!
//! A Quinn connection with the transport defaults (CUBIC, no pacing tweaks)
//! carrying one unidirectional stream for as long as it runs. The client dials
//! the delay proxy's `LISTEN_COMPETITOR_<DAEMON|BROWSER>` listener, whose relays
//! forward to the server and cross that role's links, so the flow competes
//! with the session at the bottleneck the profile declares. The proxy counts
//! each relay's link bytes, so neither side reports throughput.
//!
//! Usage:
//!   bulk_competitor serve   LISTEN=[::1]:4440 SEND=1
//!   bulk_competitor dial    SERVER=https://[::1]:4437 CERT_HASH=<b64> SEND=0
//!
//! `SEND=1` makes that side the sender. Competing on a peer's downlink, the
//! server sends; on its uplink, the client does. The server prints
//! `bulk_competitor: ready <address> cert_hash_b64=<hash>` once it listens.

use std::net::SocketAddr;
use std::sync::Arc;

use base64::Engine;
use wtransport::tls::Sha256Digest;
use wtransport::quinn::VarInt;
use wtransport::{ClientConfig, Endpoint, Identity, ServerConfig};

/// One write: large enough that the sender is never application limited.
const CHUNK_BYTES: usize = 64 * 1024;

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn sends() -> bool {
    match required("SEND").as_str() {
        "1" => true,
        "0" => false,
        other => panic!("SEND must be 0 or 1, not {other:?}"),
    }
}

/// Flow control never limits the flow: only the link and CUBIC do.
fn transport() -> wtransport::config::QuicTransportConfig {
    let mut transport = wtransport::config::QuicTransportConfig::default();
    transport.receive_window(VarInt::MAX);
    transport.stream_receive_window(VarInt::MAX);
    transport.send_window(u64::MAX);
    transport
}

async fn run(connection: wtransport::Connection, send: bool) {
    if send {
        let Ok(opening) = connection.open_uni().await else {
            return;
        };
        let Ok(mut stream) = opening.await else {
            return;
        };
        let chunk = vec![0x5a; CHUNK_BYTES];
        while stream.write_all(&chunk).await.is_ok() {}
    } else {
        let Ok(mut stream) = connection.accept_uni().await else {
            return;
        };
        let mut buffer = vec![0; CHUNK_BYTES];
        while matches!(stream.read(&mut buffer).await, Ok(Some(_))) {}
    }
}

#[tokio::main]
async fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let send = sends();
    match mode.as_str() {
        "serve" => {
            let listen: SocketAddr = required("LISTEN").parse().expect("LISTEN address");
            let identity =
                Identity::self_signed(["localhost", "::1", "127.0.0.1"]).expect("identity");
            let hash = *identity
                .certificate_chain()
                .as_slice()
                .first()
                .expect("one certificate")
                .hash()
                .as_ref();
            let mut config = ServerConfig::builder()
                .with_bind_address(listen)
                .with_identity(identity)
                .build();
            config
                .quic_config_mut()
                .transport_config(Arc::new(transport()));
            let endpoint = Endpoint::server(config).expect("bind competitor server");
            println!(
                "bulk_competitor: ready {} cert_hash_b64={}",
                endpoint.local_addr().expect("server address"),
                base64::engine::general_purpose::STANDARD.encode(hash)
            );
            loop {
                let incoming = endpoint.accept().await;
                tokio::spawn(async move {
                    let Ok(request) = incoming.await else {
                        return;
                    };
                    let Ok(connection) = request.accept().await else {
                        return;
                    };
                    run(connection, send).await;
                });
            }
        }
        "dial" => {
            let server = required("SERVER");
            let hash: [u8; 32] = base64::engine::general_purpose::STANDARD
                .decode(required("CERT_HASH"))
                .expect("CERT_HASH is base64")
                .try_into()
                .expect("CERT_HASH is a SHA-256 digest");
            let mut config = ClientConfig::builder()
                .with_bind_default()
                .with_server_certificate_hashes([Sha256Digest::new(hash)])
                .build();
            config
                .quic_config_mut()
                .transport_config(Arc::new(transport()));
            let endpoint = Endpoint::client(config).expect("client endpoint");
            let connection = endpoint.connect(&server).await.expect("connect competitor");
            println!("bulk_competitor: connected {server}");
            run(connection, send).await;
        }
        _ => panic!("usage: bulk_competitor serve|dial"),
    }
}
