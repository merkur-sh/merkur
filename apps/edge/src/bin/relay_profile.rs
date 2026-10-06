//! Authenticated, fixed-completed-work load for a separately measured edge process.
use base64::Engine;
use bytes::Bytes;
use merkur_edge_protocol::{
    MAX_PREFACE_LEN, PREFACE_VERSION, Role, RoutingAttachment, RoutingPreface, SpliceControlEvent,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncBufReadExt;
use wtransport::{ClientConfig, Connection, Endpoint, RecvStream, SendStream, tls::Sha256Digest};

#[expect(
    dead_code,
    reason = "the profiling issuer shares the production ticket codec; verification belongs to the edge"
)]
#[path = "../attach_ticket.rs"]
mod attach_ticket;

type Error = Box<dyn std::error::Error + Send + Sync>;
const DEADLINE: Duration = Duration::from_secs(10);
const DAEMON: &str = "edge-profile";
/// The one dataplane process every profiled daemon tunnel comes from.
const INCARNATION: &str = "cHJvZmlsZWluY2FybmF0aQ";
// Current production daemon quote-lane preface, also used by hol_probe.
const QUOTE: &[u8] = b"merkur-edge-quote-v1";

struct Peer {
    _endpoint: Endpoint<wtransport::endpoint::endpoint_side::Client>,
    connection: Connection,
    _send: Vec<SendStream>,
    control: RecvStream,
}

async fn event(recv: &mut RecvStream) -> Result<SpliceControlEvent, Error> {
    let mut length = [0; 4];
    tokio::time::timeout(DEADLINE, recv.read_exact(&mut length)).await??;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_PREFACE_LEN {
        return Err("oversized lifecycle event".into());
    }
    let mut body = vec![0; length];
    tokio::time::timeout(DEADLINE, recv.read_exact(&mut body)).await??;
    Ok(serde_json::from_slice(&body)?)
}

fn drain(mut recv: RecvStream) {
    tokio::spawn(async move {
        let mut body = [0; 4096];
        while let Ok(Some(_)) = recv.read(&mut body).await {}
    });
}

async fn attach(url: &str, hash: [u8; 32], label: &str, role: Role) -> Result<Peer, Error> {
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes([Sha256Digest::new(hash)])
        .build();
    let endpoint = Endpoint::client(config)?;
    let connection = tokio::time::timeout(DEADLINE, endpoint.connect(url)).await??;
    let (mut send, control) = connection.open_bi().await?.await?;
    let key = attach_ticket::AttachTicketKey::from_base64url(&std::env::var(
        "MERKUR_EDGE_ATTACH_TICKET_KEY",
    )?)?;
    let ticket_role = match role {
        Role::Daemon => attach_ticket::TicketRole::Daemon,
        Role::Browser => attach_ticket::TicketRole::Browser,
    };
    let expiry = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() + 90;
    send.write_all(
        &RoutingPreface {
            session_id: label.into(),
            role,
            version: PREFACE_VERSION,
            attachment: match role {
                Role::Browser => RoutingAttachment::Primary,
                Role::Daemon => RoutingAttachment::Tunnel {
                    incarnation: INCARNATION.into(),
                },
            },
            daemon_id: DAEMON.into(),
            ticket: key
                .issue(ticket_role, DAEMON, label, expiry)
                .map_err(|e| format!("ticket: {e:?}"))?,
        }
        .encode(),
    )
    .await?;
    let mut streams = vec![send];
    if role == Role::Daemon {
        let (mut send, recv) = connection.open_bi().await?.await?;
        send.write_all(QUOTE).await?;
        drain(recv);
        streams.push(send);
    }
    Ok(Peer {
        _endpoint: endpoint,
        connection,
        _send: streams,
        control,
    })
}

async fn paired(control: &mut RecvStream, expected: bool) -> Result<(), Error> {
    loop {
        match event(control).await? {
            SpliceControlEvent::CounterpartPresent { present, .. } if present == expected => {
                return Ok(());
            }
            SpliceControlEvent::CounterpartAttached { .. } if expected => return Ok(()),
            SpliceControlEvent::ObservedPath { .. }
            | SpliceControlEvent::CounterpartProbing { .. }
            | SpliceControlEvent::CounterpartResponsive { .. } => {}
            other => return Err(format!("unexpected pairing event: {other:?}").into()),
        }
    }
}

fn payload(id: u64, length: usize) -> Bytes {
    let mut body = vec![0x5a; length];
    body[..8].copy_from_slice(&id.to_be_bytes());
    Bytes::from(body)
}

async fn received(connection: &Connection, body: &Bytes) -> Result<(), Error> {
    let actual = tokio::time::timeout(DEADLINE, connection.receive_datagram()).await??;
    if actual.as_ref() != body.as_ref() {
        return Err("missing, duplicate, reordered or corrupt datagram".into());
    }
    Ok(())
}

async fn datagrams(
    source: &Connection,
    destination: &Connection,
    count: usize,
    burst: usize,
) -> Result<(Vec<u64>, u64), Error> {
    let mut samples = Vec::with_capacity(count * burst);
    let mut bytes = 0;
    for group in 0..count {
        let bodies: Vec<_> = (0..burst)
            .map(|i| payload((group * burst + i) as u64, if i == 0 { 57 } else { 1100 }))
            .collect();
        let start = Instant::now();
        for body in &bodies {
            source.send_datagram_owned(body.clone())?;
        }
        for body in &bodies {
            received(destination, body).await?;
            bytes += body.len() as u64;
            samples.push(start.elapsed().as_nanos() as u64);
        }
    }
    Ok((samples, bytes))
}

async fn stream(
    source: &Connection,
    destination: &Connection,
    count: usize,
) -> Result<(Vec<u64>, u64), Error> {
    let mut send = source.open_uni().await?.await?;
    send.write_all(&[0x7f]).await?;
    // A warm record opens the forwarded lane; only an empty FIN is a counterpart probe.
    let body = payload(0, 64 * 1024);
    send.write_all(&(body.len() as u32).to_be_bytes()).await?;
    send.write_all(&body).await?;
    let mut recv = loop {
        let mut recv = tokio::time::timeout(DEADLINE, destination.accept_uni()).await??;
        let mut prefix = [0; 9];
        if recv.read(&mut prefix[..1]).await?.is_none() {
            continue;
        }
        recv.read_exact(&mut prefix[1..]).await?;
        if prefix[8] != 0x7f {
            return Err("wrong reliable lane".into());
        }
        break recv;
    };
    let mut wire = vec![0; body.len() + 4];
    recv.read_exact(&mut wire).await?;
    if wire[..4] != (body.len() as u32).to_be_bytes() || wire[4..] != body[..] {
        return Err("corrupt warm record".into());
    }
    let mut samples = Vec::with_capacity(count);
    for id in 1..=count {
        let body = payload(id as u64, 64 * 1024);
        let start = Instant::now();
        send.write_all(&(body.len() as u32).to_be_bytes()).await?;
        send.write_all(&body).await?;
        tokio::time::timeout(DEADLINE, recv.read_exact(&mut wire)).await??;
        if wire[..4] != (body.len() as u32).to_be_bytes() || wire[4..] != body[..] {
            return Err("corrupt reliable record".into());
        }
        samples.push(start.elapsed().as_nanos() as u64);
    }
    Ok((samples, count as u64 * body.len() as u64))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let url = std::env::var("MERKUR_EDGE_URL")?;
    let hash: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(std::env::var("MERKUR_EDGE_CERT_HASH")?)?
        .try_into()
        .map_err(|_| "hash must be 32 bytes")?;
    let workload = std::env::var("EDGE_PROFILE_WORKLOAD").unwrap_or_else(|_| "typing".into());
    let (sessions, count, burst) = match workload.as_str() {
        "typing" => (1, 10_000, 1),
        "concurrent" => (8, 10_000, 1),
        "burst" => (1, 512, 32),
        "stream" => (1, 1024, 1),
        _ => return Err("workload must be typing, concurrent, burst or stream".into()),
    };
    let mut peers = Vec::with_capacity(sessions);
    for index in 0..sessions {
        let label = format!("profile-{}-{index}", std::process::id());
        let mut daemon = attach(&url, hash, &label, Role::Daemon).await?;
        paired(&mut daemon.control, false).await?;
        let mut browser = attach(&url, hash, &label, Role::Browser).await?;
        paired(&mut browser.control, true).await?;
        paired(&mut daemon.control, true).await?;
        datagrams(&daemon.connection, &browser.connection, 32, 1).await?;
        drain(daemon.control);
        drain(browser.control);
        peers.push((
            daemon._endpoint,
            browser._endpoint,
            daemon._send,
            browser._send,
            daemon.connection,
            browser.connection,
        ));
    }
    println!("@@edge-profile-ready");
    let mut line = String::new();
    tokio::io::BufReader::new(tokio::io::stdin())
        .read_line(&mut line)
        .await?;
    if line.trim() != "go" {
        return Err("expected measurement rendezvous: go".into());
    }
    let start = Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    for owners in peers {
        let workload = workload.clone();
        tasks.spawn(async move {
            let result = if workload == "stream" {
                stream(&owners.4, &owners.5, count).await
            } else {
                datagrams(&owners.4, &owners.5, count, burst).await
            };
            drop(owners);
            result
        });
    }
    let mut latencies = Vec::with_capacity(sessions * count * burst);
    let mut bytes = 0;
    while let Some(result) = tasks.join_next().await {
        let (samples, delivered) = result??;
        latencies.extend(samples);
        bytes += delivered;
    }
    let wall_ns = start.elapsed().as_nanos() as u64;
    latencies.sort_unstable();
    let percentile = |p: usize| latencies[(latencies.len() * p).div_ceil(100) - 1];
    std::fs::write(
        std::env::var("EDGE_PROFILE_SAMPLES")?,
        serde_json::to_vec(&latencies)?,
    )?;
    println!(
        "@@edge-linux-profile {}",
        serde_json::json!({
            "workload": workload, "sessions": sessions, "offered": sessions * count * burst,
            "delivered": latencies.len(), "delivered_bytes": bytes, "wall_ns": wall_ns,
            "p50_ns": percentile(50), "p95_ns": percentile(95), "p99_ns": percentile(99),
            "latency_boundary": "source admission to validated destination receive; two QUIC legs; closed-loop groups",
        })
    );
    Ok(())
}
