//! merkur-edge-migration-probe — does a client survive an address change
//! without a handshake, and what does that save?
//!
//! Merkur's daemon loses its edge tunnel whenever the host's network path
//! changes: the socket is bound to an address the new path no longer owns, so
//! the connection dies and is rebuilt by `EdgeTunnel::connect_with_backoff` —
//! a full QUIC/TLS/H3 handshake. RFC 9000 §9 says that is avoidable: the
//! connection is identified by its connection ID, not its 4-tuple, so a server
//! that permits migration answers packets from a new address with path
//! validation (PATH_CHALLENGE/PATH_RESPONSE) and keeps the connection.
//!
//! quinn implements this and wtransport enables it by default
//! (`ServerConfigBuilder::allow_migration`, never overridden in this repo), so
//! the claim under test is not "can we build migration" but "is it already
//! there, and is it actually cheaper than redialing".
//!
//! The measurement, per iteration, against one self-signed server:
//!   A (migrate) rebind the CLIENT's UDP socket under a live connection, then
//!               time until an application round trip completes again.
//!   B (redial)  drop the connection and run `Endpoint::connect` again, then
//!               time the same round trip.
//!
//! Both arms recover from the same starting state and are timed to the same
//! event — first byte of application data back — so the difference is the
//! handshake, not bookkeeping.
//!
//! ## Why the relay exists
//!
//! A client rebind changes the client's source address. Without something in
//! the middle the server would still see the same address (loopback source
//! selection) and never exercise migration at all. The relay gives each
//! distinct client source address its own upstream socket, so a rebind reaches
//! the server as a new 4-tuple — exactly what a NAT rebinding or an interface
//! change looks like from the server's side. It also injects a fixed one-way
//! delay, because on loopback every handshake is sub-millisecond and the
//! round-trip *count* — the thing that actually differs — would be invisible.
//!
//! Usage:
//!   cargo run -p merkur-edge --bin migration_probe --release
//! Tuning: MIGRATION_PROBE_DELAY_MS (25), MIGRATION_PROBE_REPS (5).

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket as StdUdpSocket};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Connection, Endpoint, Identity, ServerConfig};

/// One-way delay the relay injects, so a saved round trip is legible.
fn delay_ms() -> u64 {
    std::env::var("MIGRATION_PROBE_DELAY_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(25)
}

fn reps() -> usize {
    std::env::var("MIGRATION_PROBE_REPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5)
}

const ECHO_BYTE: u8 = 0xA5;
/// Bound on any single recovery attempt. Well above a handshake through the
/// injected delay; a run that hits this is a failure, not a slow success.
const RECOVERY_TIMEOUT: Duration = Duration::from_secs(10);

/// A NAT-like UDP relay.
///
/// Per distinct client source address it allocates one upstream socket, so the
/// server observes a *different* source when the client rebinds — the property
/// that makes this a migration test rather than a loopback no-op. Both
/// directions are delayed by `delay`, giving a `2 * delay` RTT.
async fn spawn_relay(server_addr: SocketAddr, delay: Duration) -> std::io::Result<SocketAddr> {
    let downstream = Arc::new(UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?);
    let relay_addr = downstream.local_addr()?;
    // client source address -> its dedicated upstream socket
    let upstreams: Arc<Mutex<HashMap<SocketAddr, Arc<UdpSocket>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let recv_sock = Arc::clone(&downstream);
    tokio::spawn(async move {
        let mut buf = vec![0u8; 2048];
        loop {
            let Ok((len, client_addr)) = recv_sock.recv_from(&mut buf).await else {
                break;
            };
            let packet = buf[..len].to_vec();

            let upstream = {
                let mut map = upstreams.lock().await;
                match map.get(&client_addr) {
                    Some(existing) => Arc::clone(existing),
                    None => {
                        // First packet from this client address: give it its own
                        // upstream socket and pump that socket's replies back.
                        let Ok(up) = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await else {
                            continue;
                        };
                        let up = Arc::new(up);
                        map.insert(client_addr, Arc::clone(&up));

                        let back = Arc::clone(&recv_sock);
                        let up_reader = Arc::clone(&up);
                        tokio::spawn(async move {
                            let mut rbuf = vec![0u8; 2048];
                            loop {
                                let Ok((rlen, _from)) = up_reader.recv_from(&mut rbuf).await else {
                                    break;
                                };
                                let reply = rbuf[..rlen].to_vec();
                                let back = Arc::clone(&back);
                                tokio::spawn(async move {
                                    tokio::time::sleep(delay).await;
                                    let _ = back.send_to(&reply, client_addr).await;
                                });
                            }
                        });
                        up
                    }
                }
            };

            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                let _ = upstream.send_to(&packet, server_addr).await;
            });
        }
    });

    Ok(relay_addr)
}

/// Accepts sessions forever and echoes one byte per opened bi stream. The echo
/// is the application-level round trip both arms are timed to.
fn spawn_server() -> std::io::Result<(SocketAddr, [u8; 32])> {
    let identity = Identity::self_signed(["localhost", "127.0.0.1"])
        .map_err(|e| std::io::Error::other(format!("self-signed identity: {e}")))?;
    let cert_hash: [u8; 32] = *identity
        .certificate_chain()
        .as_slice()
        .first()
        .expect("self-signed chain has one certificate")
        .hash()
        .as_ref();

    let config = ServerConfig::builder()
        .with_bind_address((Ipv4Addr::LOCALHOST, 0).into())
        .with_identity(identity)
        .build();
    let endpoint = Endpoint::server(config)?;
    let addr = endpoint.local_addr()?;

    tokio::spawn(async move {
        loop {
            let incoming = endpoint.accept().await;
            tokio::spawn(async move {
                let Ok(session) = incoming.await else { return };
                let Ok(conn) = session.accept().await else {
                    return;
                };
                loop {
                    let Ok((mut tx, mut rx)) = conn.accept_bi().await else {
                        return;
                    };
                    tokio::spawn(async move {
                        let mut b = [0u8; 1];
                        if rx.read_exact(&mut b).await.is_ok() {
                            let _ = tx.write_all(&b).await;
                            let _ = tx.finish().await;
                        }
                    });
                }
            });
        }
    });

    Ok((addr, cert_hash))
}

fn client_config(cert_hash: [u8; 32]) -> ClientConfig {
    // Bound to IPv4 loopback explicitly, not `with_bind_default()`: the default
    // is a dual-stack `[::]:0`, and the rebind below hands quinn an IPv4 socket.
    // Both ends of the probe must stay in one address family or the rebind is
    // measuring an address-family switch rather than a path change.
    let mut config = ClientConfig::builder()
        .with_bind_address(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .with_server_certificate_hashes([Sha256Digest::new(cert_hash)])
        .build();
    // The same transport tuning the daemon's edge tunnel uses, so handshake
    // pacing here matches production rather than quinn's slower defaults.
    let mut transport = wtransport::config::QuicTransportConfig::default();
    transport.initial_rtt(Duration::from_millis(100));
    config
        .quic_config_mut()
        .transport_config(Arc::new(transport));
    config
}

/// One application round trip: open a bi stream, write a byte, read it back.
/// Returns false if the connection cannot carry it.
async fn round_trip(conn: &Connection) -> bool {
    let Ok(opening) = conn.open_bi().await else {
        return false;
    };
    let Ok((mut tx, mut rx)) = opening.await else {
        return false;
    };
    if tx.write_all(&[ECHO_BYTE]).await.is_err() {
        return false;
    }
    let mut b = [0u8; 1];
    rx.read_exact(&mut b).await.is_ok() && b[0] == ECHO_BYTE
}

/// Retry a round trip until one succeeds or the budget expires. During
/// migration the first attempts can fail while path validation is in flight;
/// what is being timed is when the connection carries data again.
async fn time_to_usable(conn: &Connection, started: Instant) -> Option<f64> {
    let deadline = started + RECOVERY_TIMEOUT;
    while Instant::now() < deadline {
        if round_trip(conn).await {
            return Some(started.elapsed().as_secs_f64() * 1000.0);
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    None
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).expect("no NaN timings"));
    let mid = values.len() / 2;
    if values.len().is_multiple_of(2) {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let delay = Duration::from_millis(delay_ms());
    let reps = reps();
    let (server_addr, cert_hash) = spawn_server()?;
    let relay_addr = spawn_relay(server_addr, delay).await?;
    let url = format!("https://127.0.0.1:{}", relay_addr.port());

    println!(
        "migration_probe: one-way delay {} ms (RTT {} ms), {} reps",
        delay.as_millis(),
        delay.as_millis() * 2,
        reps
    );

    let mut migrate_ms = Vec::new();
    let mut redial_ms = Vec::new();

    for rep in 0..reps {
        // --- arm A: rebind the live connection's socket, keep the connection ---
        let endpoint = Endpoint::client(client_config(cert_hash))?;
        let conn = endpoint
            .connect(&url)
            .await
            .map_err(|e| std::io::Error::other(format!("connect: {e}")))?;
        if !round_trip(&conn).await {
            return Err(std::io::Error::other("baseline round trip failed"));
        }

        let fresh = StdUdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
        let started = Instant::now();
        endpoint.rebind(fresh)?;
        let migrated = time_to_usable(&conn, started).await;

        match migrated {
            Some(ms) => migrate_ms.push(ms),
            None => {
                println!("  rep {rep}: MIGRATION FAILED — connection never recovered");
            }
        }
        drop(conn);
        endpoint.close(0u32.into(), b"probe");

        // --- arm B: full redial from a fresh endpoint ---
        let started = Instant::now();
        let endpoint2 = Endpoint::client(client_config(cert_hash))?;
        let conn2 = endpoint2
            .connect(&url)
            .await
            .map_err(|e| std::io::Error::other(format!("redial: {e}")))?;
        match time_to_usable(&conn2, started).await {
            Some(ms) => redial_ms.push(ms),
            None => println!("  rep {rep}: REDIAL FAILED"),
        }
        drop(conn2);
        endpoint2.close(0u32.into(), b"probe");
    }

    println!();
    if migrate_ms.is_empty() {
        println!("migrate (rebind live connection): NEVER RECOVERED in {reps} reps");
    } else {
        println!(
            "migrate (rebind live connection): median {:.1} ms  (n={}, min {:.1}, max {:.1})",
            median(migrate_ms.clone()),
            migrate_ms.len(),
            migrate_ms.iter().cloned().fold(f64::INFINITY, f64::min),
            migrate_ms.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
        );
    }
    if !redial_ms.is_empty() {
        println!(
            "redial  (fresh handshake)       : median {:.1} ms  (n={}, min {:.1}, max {:.1})",
            median(redial_ms.clone()),
            redial_ms.len(),
            redial_ms.iter().cloned().fold(f64::INFINITY, f64::min),
            redial_ms.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
        );
    }
    if !migrate_ms.is_empty() && !redial_ms.is_empty() {
        let m = median(migrate_ms);
        let r = median(redial_ms);
        println!(
            "\nsaving: {:.1} ms ({:.0}% of the redial cost), RTT is {} ms",
            r - m,
            (r - m) / r * 100.0,
            delay.as_millis() * 2
        );
    }

    Ok(())
}
