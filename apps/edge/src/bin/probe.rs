//! merkur-edge-probe — end-to-end splice verifier for a running edge.
//!
//! Connects native daemon/browser WebTransport clients to a live edge and
//! proves that datagrams and a persistent reliable lane round-trip unchanged.
//! Reliable wire shape is `[channel:u8 once][u32be body length][body]*`.
//!
//! Usage:
//!   MERKUR_EDGE_URL=https://localhost:4433 \
//!   MERKUR_EDGE_CERT_HASH=<base64 sha-256 from the edge startup log> \
//!   cargo run -p merkur-edge --bin probe

#[expect(dead_code, reason = "the probe uses only part of the shared ticket module")]
#[path = "../attach_ticket.rs"]
mod attach_ticket;

use std::io;
use std::time::Duration;

use base64::Engine;
use merkur_edge_protocol::{PREFACE_VERSION, Role, RoutingAttachment, RoutingPreface};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Endpoint};

const DAEMON_TAG: u8 = 0xAA;
const DAEMON_RELIABLE_TAG: u8 = 0xBB;
const PROBE_CHANNEL: u8 = 0x7F;
const RELIABLE_RECORD_HEADER_BYTES: usize = 4;
const MAX_RELIABLE_BODY: usize = 8 * 1024 * 1024 - 5;
/// `apps/edge/src/relay.rs` `DELIVERY_QUOTE_STREAM_PREFACE`.
const DELIVERY_QUOTE_STREAM_PREFACE: &[u8] = b"merkur-edge-quote-v1";

#[cfg(test)]
fn reliable_record(body: &[u8]) -> Vec<u8> {
    let body_len = u32::try_from(body.len()).expect("probe reliable body fits u32");
    let mut record = Vec::with_capacity(RELIABLE_RECORD_HEADER_BYTES + body.len());
    record.extend_from_slice(&body_len.to_be_bytes());
    record.extend_from_slice(body);
    record
}

#[cfg(test)]
fn parse_reliable_records(mut wire: &[u8]) -> Option<Vec<&[u8]>> {
    let mut records = Vec::new();
    while !wire.is_empty() {
        let header = wire.get(..RELIABLE_RECORD_HEADER_BYTES)?;
        let body_len = u32::from_be_bytes(header.try_into().ok()?) as usize;
        if body_len > MAX_RELIABLE_BODY {
            return None;
        }
        let record_len = RELIABLE_RECORD_HEADER_BYTES.checked_add(body_len)?;
        let body = wire.get(RELIABLE_RECORD_HEADER_BYTES..record_len)?;
        records.push(body);
        wire = wire.get(record_len..)?;
    }
    Some(records)
}

async fn read_record<R>(source: &mut R) -> io::Result<Option<Vec<u8>>>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0u8; RELIABLE_RECORD_HEADER_BYTES];
    if source.read(&mut header[..1]).await? == 0 {
        return Ok(None);
    }
    source.read_exact(&mut header[1..]).await?;
    let body_len = u32::from_be_bytes(header) as usize;
    if body_len > MAX_RELIABLE_BODY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "oversized reliable record",
        ));
    }
    let mut body = vec![0u8; body_len];
    source.read_exact(&mut body).await?;
    Ok(Some(body))
}

async fn write_record<W>(destination: &mut W, body: &[u8]) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let body_len = u32::try_from(body.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "record too large"))?;
    destination.write_all(&body_len.to_be_bytes()).await?;
    destination.write_all(body).await
}

/// The daemon id this tool attaches as. Any id works: the edge checks only that
/// both ends' tickets name the same one.
const PROBE_DAEMON_ID: &str = "edge-probe";
/// The incarnation its daemon tunnels name; one per run is all the edge needs.
const PROBE_INCARNATION: &str = "cHJvYmVpbmNhcm5hdGlvbg";

/// Mint the ticket the edge requires, from the deployment key the edge runs
/// with (`MERKUR_EDGE_ATTACH_TICKET_KEY`), for one role on one session.
fn ticket(session_id: &str, role: &str) -> String {
    let key = std::env::var("MERKUR_EDGE_ATTACH_TICKET_KEY")
        .expect("set MERKUR_EDGE_ATTACH_TICKET_KEY to the edge's attach ticket key");
    let key = attach_ticket::AttachTicketKey::from_base64url(key.trim()).expect("attach ticket key");
    let role = if role == "daemon" {
        attach_ticket::TicketRole::Daemon
    } else {
        attach_ticket::TicketRole::Browser
    };
    let expiry = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after the epoch")
        .as_secs()
        + 90;
    key.issue(role, PROBE_DAEMON_ID, session_id, expiry)
        .expect("probe ticket")
}

fn preface(session_id: &str, role: &str) -> Vec<u8> {
    RoutingPreface {
        session_id: session_id.to_string(),
        role: if role == "daemon" {
            Role::Daemon
        } else {
            Role::Browser
        },
        version: PREFACE_VERSION,
        attachment: if role == "daemon" {
            RoutingAttachment::Tunnel {
                incarnation: PROBE_INCARNATION.to_string(),
            }
        } else {
            RoutingAttachment::Primary
        },
        daemon_id: PROBE_DAEMON_ID.to_string(),
        ticket: ticket(session_id, role),
    }
    .encode()
}

async fn connect(
    url: &str,
    digest: Sha256Digest,
) -> Result<wtransport::Connection, Box<dyn std::error::Error + Send + Sync>> {
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes([digest])
        .build();
    let endpoint = Endpoint::client(config)?;
    Ok(endpoint.connect(url).await?)
}

/// Drain `recv` until the edge finishes it. Dropping it instead would stop the
/// edge's writes on it, and a stopped lifecycle or quote lane detaches the peer.
fn drain(mut recv: wtransport::RecvStream) {
    tokio::spawn(async move {
        let mut sink = [0u8; 1024];
        while let Ok(Some(_)) = recv.read(&mut sink).await {}
    });
}

/// Attach `role` under `session_id`. The returned streams must outlive the
/// attachment: the preface stream, and for the daemon the delivery-quote
/// stream the edge requires of it.
async fn send_preface(
    conn: &wtransport::Connection,
    session_id: &str,
    role: &str,
) -> Result<Vec<wtransport::SendStream>, Box<dyn std::error::Error + Send + Sync>> {
    let (mut send, recv) = conn.open_bi().await?.await?;
    send.write_all(&preface(session_id, role)).await?;
    drain(recv);
    let mut streams = vec![send];
    if role == "daemon" {
        let (mut quote, recv) = conn.open_bi().await?.await?;
        quote.write_all(DELIVERY_QUOTE_STREAM_PREFACE).await?;
        drain(recv);
        streams.push(quote);
    }
    Ok(streams)
}

async fn open_lane(
    conn: &wtransport::Connection,
    channel: u8,
) -> Result<wtransport::SendStream, Box<dyn std::error::Error + Send + Sync>> {
    let opening = conn.open_uni().await?;
    let mut send = opening.await?;
    send.write_all(&[channel]).await?;
    Ok(send)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let url = std::env::var("MERKUR_EDGE_URL").unwrap_or_else(|_| "https://localhost:4433".into());
    let hash_b64 = std::env::var("MERKUR_EDGE_CERT_HASH")
        .expect("set MERKUR_EDGE_CERT_HASH to the edge's base64 SHA-256 cert hash");
    let hash_bytes = base64::engine::general_purpose::STANDARD
        .decode(hash_b64.trim())
        .expect("cert hash is valid base64");
    let hash: [u8; 32] = hash_bytes
        .as_slice()
        .try_into()
        .expect("cert hash is 32 bytes");
    let digest = Sha256Digest::new(hash);

    let session_id = format!("probe-{}", std::process::id());
    tracing::info!(%url, %session_id, "probe: connecting both roles to the edge");

    let daemon_digest = digest.clone();
    let daemon_url = url.clone();
    let daemon_session = session_id.clone();
    let daemon = tokio::spawn(async move {
        let conn = connect(&daemon_url, daemon_digest)
            .await
            .expect("daemon role failed to connect");
        let _preface_stream = send_preface(&conn, &daemon_session, "daemon")
            .await
            .expect("daemon preface");

        loop {
            tokio::select! {
                datagram = conn.receive_datagram() => match datagram {
                    Ok(datagram) => {
                        let mut response = vec![DAEMON_TAG];
                        response.extend_from_slice(&datagram.payload());
                        let _ = conn.send_datagram(response);
                    }
                    Err(_) => break,
                },
                lane = conn.accept_uni() => match lane {
                    Ok(mut source) => {
                        let conn = conn.clone();
                        tokio::spawn(async move {
                            let mut channel = [0u8; 9];
                            if source.read_exact(&mut channel).await.is_err() {
                                return;
                            }
                            let Ok(mut destination) = open_lane(&conn, channel[8]).await else {
                                return;
                            };
                            loop {
                                let Ok(Some(body)) = read_record(&mut source).await else {
                                    return;
                                };
                                let mut response = Vec::with_capacity(1 + body.len());
                                response.push(DAEMON_RELIABLE_TAG);
                                response.extend_from_slice(&body);
                                if write_record(&mut destination, &response).await.is_err() {
                                    return;
                                }
                            }
                        });
                    }
                    Err(_) => break,
                },
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(500)).await;

    let browser = connect(&url, digest)
        .await
        .expect("browser role failed to connect");
    let _browser_preface = send_preface(&browser, &session_id, "browser")
        .await
        .expect("browser preface");

    let ping = b"merkur-opaque-ciphertext-datagram".to_vec();
    let mut datagram_ok = false;
    for attempt in 0..25 {
        browser.send_datagram(ping.clone()).expect("send datagram");
        if let Ok(Ok(datagram)) =
            tokio::time::timeout(Duration::from_millis(200), browser.receive_datagram()).await
        {
            let payload = datagram.payload();
            if payload.first() == Some(&DAEMON_TAG) && &payload[1..] == ping.as_slice() {
                tracing::info!(attempt, "probe: datagram round-trip OK");
                datagram_ok = true;
                break;
            }
        }
    }

    let mut reliable_ok = false;
    if datagram_ok {
        let payload = b"merkur-opaque-ciphertext-persistent-reliable-lane";
        let mut send = open_lane(&browser, PROBE_CHANNEL)
            .await
            .expect("browser reliable lane");
        write_record(&mut send, payload)
            .await
            .expect("browser reliable record");

        if let Ok(Ok(mut recv)) =
            tokio::time::timeout(Duration::from_secs(3), browser.accept_uni()).await
        {
            let mut channel = [0u8; 9];
            if recv.read_exact(&mut channel).await.is_ok()
                && let Ok(Some(body)) = read_record(&mut recv).await
            {
                reliable_ok = channel[8] == PROBE_CHANNEL
                    && body.first() == Some(&DAEMON_RELIABLE_TAG)
                    && &body[1..] == payload;
            }
        }
        if reliable_ok {
            tracing::info!("probe: persistent reliable round-trip OK");
        }
    }

    daemon.abort();

    if datagram_ok && reliable_ok {
        println!(
            "PROBE PASS: blind splice relays opaque datagrams and persistent reliable records via {url}"
        );
        return;
    }
    eprintln!("PROBE FAIL: datagram_ok={datagram_ok} reliable_ok={reliable_ok} (url={url})");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_wire_has_one_channel_prefix_and_multiple_exact_records() {
        let mut lane = vec![0xA5];
        lane.extend_from_slice(&reliable_record(b"one"));
        lane.extend_from_slice(&reliable_record(b""));
        lane.extend_from_slice(&reliable_record(b"three"));

        assert_eq!(lane[0], 0xA5);
        assert_eq!(
            parse_reliable_records(&lane[1..]),
            Some(vec![&b"one"[..], &b""[..], &b"three"[..]])
        );

        let mut truncated = lane.clone();
        truncated.pop();
        assert!(parse_reliable_records(&truncated[1..]).is_none());

        let mut trailing = lane;
        trailing.push(0);
        assert!(parse_reliable_records(&trailing[1..]).is_none());
    }

    #[tokio::test]
    async fn record_helpers_roundtrip_concatenated_records() {
        let (mut writer, mut reader) = tokio::io::duplex(64);
        write_record(&mut writer, b"first").await.expect("first");
        write_record(&mut writer, b"second").await.expect("second");
        writer.shutdown().await.expect("finish");

        assert_eq!(
            read_record(&mut reader).await.unwrap(),
            Some(b"first".to_vec())
        );
        assert_eq!(
            read_record(&mut reader).await.unwrap(),
            Some(b"second".to_vec())
        );
        assert_eq!(read_record(&mut reader).await.unwrap(), None);
    }
}
