//! wt-echo-server — isolated WebTransport echo server for device acceptance.
//!
//! Accepts concurrent WebTransport sessions and echoes back:
//!   - every datagram it receives, verbatim, and
//!   - every bidirectional-stream frame it receives, verbatim.
//!
//! On startup it generates a self-signed certificate and prints the
//! base64-encoded SHA-256 of the cert DER (the `serverCertificateHashes`
//! value the browser pins). This crate is STANDALONE (see the empty
//! `[workspace]` table in Cargo.toml) so it never joins the Merkur cargo
//! workspace.
//!
//! Design note: this is the sender side of the burst test. The browser
//! worker blasts a display-sized burst of datagrams; we bounce each one
//! straight back so the worker can measure received-vs-expected sequence
//! numbers, gaps (burst-tail drops), and per-datagram round-trip latency.
//!
//! No `unwrap()` in long-lived loops: per-session and per-stream errors are
//! logged and the loop continues / the task exits cleanly.

use std::net::{Ipv6Addr, SocketAddr};
use std::time::Duration;

use anyhow::Context;
use base64::Engine;
use tracing::{info, warn};
use wtransport::endpoint::IncomingSession;
use wtransport::{Endpoint, Identity, ServerConfig};

/// Default listen port. Override with WT_ECHO_PORT.
const DEFAULT_PORT: u16 = 4433;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let port: u16 = std::env::var("WT_ECHO_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Self-signed identity. SANs cover localhost plus the loopbacks; for a
    // phone on the LAN the browser pins by cert hash (serverCertificateHashes),
    // so the SAN list does not need to enumerate the Mac's LAN IP.
    let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])
        .context("failed to generate self-signed identity")?;

    let cert = identity
        .certificate_chain()
        .as_slice()
        .first()
        .context("self-signed identity had no certificate in its chain")?;

    // `cert.hash()` is the SHA-256 of the certificate DER — exactly what
    // WebTransport's `serverCertificateHashes` expects, base64-encoded here.
    let cert_hash = cert.hash();
    let cert_hash_b64 =
        base64::engine::general_purpose::STANDARD.encode(cert_hash.as_ref());

    // Bind dual-stack (IPv6 unspecified accepts mapped IPv4 too on most OSes).
    let bind_addr = SocketAddr::from((Ipv6Addr::UNSPECIFIED, port));

    let config = ServerConfig::builder()
        .with_bind_address(bind_addr)
        .with_identity(identity)
        .keep_alive_interval(Some(Duration::from_secs(4)))
        .max_idle_timeout(Some(Duration::from_secs(30)))
        .context("invalid max_idle_timeout")?
        .build();

    let endpoint = Endpoint::server(config).context("failed to bind WebTransport server")?;

    let local_addr = endpoint
        .local_addr()
        .context("failed to read local addr")?;

    info!("wt-echo-server listening on {local_addr} (UDP/QUIC/WebTransport)");
    info!("");
    info!("================ CERT HASH (base64 SHA-256) ================");
    info!("{cert_hash_b64}");
    info!("===========================================================");
    info!("");
    info!("Pin this in the browser harness as the cert hash. It rotates");
    info!("every restart (self-signed), so re-copy it whenever you restart.");

    accept_loop(endpoint).await;

    Ok(())
}

/// Long-lived accept loop. Never `unwrap`s: a failed accept is logged and the
/// loop continues so the server stays up across transient client errors.
async fn accept_loop(endpoint: Endpoint<wtransport::endpoint::endpoint_side::Server>) {
    let mut session_counter: u64 = 0;
    loop {
        let incoming = endpoint.accept().await;
        session_counter += 1;
        let session_id = session_counter;
        tokio::spawn(async move {
            if let Err(e) = handle_session(incoming, session_id).await {
                warn!("session {session_id} ended with error: {e:#}");
            } else {
                info!("session {session_id} closed");
            }
        });
    }
}

/// Drive a single WebTransport session: accept it, then concurrently echo
/// datagrams and accept+echo bidirectional streams until the session closes.
async fn handle_session(incoming: IncomingSession, session_id: u64) -> anyhow::Result<()> {
    let session_request = incoming
        .await
        .context("incoming session failed before request")?;

    info!(
        "session {session_id}: request authority={:?} path={:?}",
        session_request.authority(),
        session_request.path()
    );

    let connection = session_request
        .accept()
        .await
        .context("failed to accept session")?;

    info!("session {session_id}: accepted");

    // Datagram echo loop.
    let dgram_conn = connection.clone();
    let dgram_task = tokio::spawn(async move {
        let mut echoed: u64 = 0;
        loop {
            match dgram_conn.receive_datagram().await {
                Ok(dgram) => {
                    // Bounce it straight back. Cloning the payload bytes keeps
                    // this simple; the acceptance burst sizes are small.
                    let payload = dgram.payload();
                    if let Err(e) = dgram_conn.send_datagram(payload.clone()) {
                        // Datagram send can fail if the peer buffer is full or
                        // the session is going away — log and keep draining.
                        warn!("session {session_id}: datagram echo send failed: {e}");
                    } else {
                        echoed += 1;
                        if echoed % 1000 == 0 {
                            info!("session {session_id}: echoed {echoed} datagrams");
                        }
                    }
                }
                Err(e) => {
                    info!("session {session_id}: datagram stream ended: {e}");
                    break;
                }
            }
        }
    });

    // Bidirectional-stream echo loop.
    let stream_conn = connection.clone();
    let stream_task = tokio::spawn(async move {
        loop {
            match stream_conn.accept_bi().await {
                Ok((send, recv)) => {
                    tokio::spawn(echo_bi_stream(send, recv, session_id));
                }
                Err(e) => {
                    info!("session {session_id}: bi-stream acceptor ended: {e}");
                    break;
                }
            }
        }
    });

    // Wait for either loop to terminate (which happens when the session
    // closes). Then make sure the other is wound down.
    tokio::select! {
        _ = dgram_task => {}
        _ = stream_task => {}
    }

    Ok(())
}

/// Echo a single bidirectional stream frame-by-frame until EOF.
async fn echo_bi_stream(
    mut send: wtransport::SendStream,
    mut recv: wtransport::RecvStream,
    session_id: u64,
) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match recv.read(&mut buf).await {
            Ok(Some(n)) if n > 0 => {
                if let Err(e) = send.write_all(&buf[..n]).await {
                    warn!("session {session_id}: stream echo write failed: {e}");
                    return;
                }
            }
            Ok(Some(_)) => {
                // Zero-length read: nothing to echo, keep reading.
            }
            Ok(None) => {
                // Clean EOF from the peer; finish our side and exit.
                if let Err(e) = send.finish().await {
                    warn!("session {session_id}: stream finish failed: {e}");
                }
                return;
            }
            Err(e) => {
                warn!("session {session_id}: stream read failed: {e}");
                return;
            }
        }
    }
}
