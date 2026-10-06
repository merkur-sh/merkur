//! merkur-edge-hol-probe — persistent-lane head-of-line measurement.
//!
//! A daemon-side display-commit lane continuously writes framed flood records
//! while a separate reliable CTRL lane carries browser ping / daemon pong
//! records. Both lanes stay open for the complete run and the browser fully
//! drains every display record. The edge remains blind to both channel bytes.
//!
//! Usage:
//!   MERKUR_EDGE_URL=https://localhost:4433 \
//!   MERKUR_EDGE_CERT_HASH=<base64 sha-256 from the edge startup log> \
//!   cargo run -p merkur-edge --bin hol_probe
//!
//! Optional tuning: HOL_PHASE_MS (3000), HOL_SETTLE_MS (300),
//! HOL_PING_MS (50), HOL_MIN_SAMPLES (20), HOL_DGRAM_BYTES (1100),
//! HOL_STREAM_BYTES (32768), HOL_MAX_P95_INFLATION_X (3.0), and
//! HOL_MAX_LOSS_PCT (5.0).

#[expect(dead_code, reason = "the probe uses only part of the shared ticket module")]
#[path = "../attach_ticket.rs"]
mod attach_ticket;

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use merkur_edge_protocol::{PREFACE_VERSION, Role, RoutingAttachment, RoutingPreface};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, oneshot};
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Endpoint};

const PING: u8 = 0x01;
const PONG: u8 = 0x02;
const FLOOD_STREAM: u8 = 0x03;
const FLOOD_DGRAM: u8 = 0x04;
const CMD_OFF: u8 = 0x10;
const CMD_DGRAM: u8 = 0x11;
const CMD_STREAM: u8 = 0x12;

const CHANNEL_CTRL: u8 = 0x02;
const CHANNEL_DISPLAY_COMMIT: u8 = 0x04;
const RELIABLE_RECORD_HEADER_BYTES: usize = 4;
const MAX_RELIABLE_BODY: usize = 8 * 1024 * 1024 - 5;
const RELIABLE_DRAIN_BUFFER_BYTES: usize = 16 * 1024;
const LANE_SETUP_TIMEOUT: Duration = Duration::from_secs(10);
/// `apps/edge/src/relay.rs` `DELIVERY_QUOTE_STREAM_PREFACE`.
const DELIVERY_QUOTE_STREAM_PREFACE: &[u8] = b"merkur-edge-quote-v1";

const MODE_OFF: u8 = 0;
const MODE_DGRAM: u8 = 1;
const MODE_STREAM: u8 = 2;

#[derive(Clone, Copy)]
struct PingObservation {
    sent_ms: f64,
    rtt_ms: Option<f64>,
}

#[derive(Clone, Copy, Debug)]
enum FloodKind {
    None,
    Datagram,
    Reliable,
}

#[derive(Clone)]
struct PhaseWindow {
    name: &'static str,
    start_ms: f64,
    end_ms: f64,
    flood_kind: FloodKind,
    bytes_before: u64,
    bytes_after: u64,
}

#[derive(Debug)]
struct PhaseReport {
    name: &'static str,
    sent: usize,
    received: usize,
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    loss_pct: f64,
    throughput_bytes_per_second: f64,
    flood_kind: FloodKind,
}

#[derive(Serialize)]
struct PerfMetric<'a> {
    name: &'a str,
    value: f64,
    unit: &'a str,
    direction: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    percentile: Option<f64>,
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value: &f64| value.is_finite() && *value > 0.0)
        .unwrap_or(default)
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

fn reliable_body_len(header: &[u8]) -> Option<usize> {
    if header.len() != RELIABLE_RECORD_HEADER_BYTES {
        return None;
    }
    let body_len = u32::from_be_bytes(header.try_into().ok()?) as usize;
    (body_len <= MAX_RELIABLE_BODY).then_some(body_len)
}

async fn read_record_header<R>(source: &mut R) -> io::Result<Option<usize>>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0u8; RELIABLE_RECORD_HEADER_BYTES];
    if source.read(&mut header[..1]).await? == 0 {
        return Ok(None);
    }
    source.read_exact(&mut header[1..]).await?;
    reliable_body_len(&header)
        .map(Some)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "oversized reliable record"))
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

fn now_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn percentile(sorted: &[f64], percentile: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let index = (percentile * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn summarize_phase(
    window: &PhaseWindow,
    observations: &HashMap<u64, PingObservation>,
) -> PhaseReport {
    let mut rtts: Vec<f64> = observations
        .values()
        .filter(|observation| {
            observation.sent_ms >= window.start_ms && observation.sent_ms < window.end_ms
        })
        .filter_map(|observation| observation.rtt_ms)
        .collect();
    let sent = observations
        .values()
        .filter(|observation| {
            observation.sent_ms >= window.start_ms && observation.sent_ms < window.end_ms
        })
        .count();
    rtts.sort_by(|left, right| left.total_cmp(right));
    let received = rtts.len();
    let loss_pct = if sent == 0 {
        100.0
    } else {
        ((sent - received) as f64 / sent as f64) * 100.0
    };
    let elapsed_seconds = (window.end_ms - window.start_ms) / 1000.0;
    let throughput = if elapsed_seconds > 0.0 {
        window.bytes_after.saturating_sub(window.bytes_before) as f64 / elapsed_seconds
    } else {
        0.0
    };

    PhaseReport {
        name: window.name,
        sent,
        received,
        p50_ms: percentile(&rtts, 0.50),
        p95_ms: percentile(&rtts, 0.95),
        p99_ms: percentile(&rtts, 0.99),
        loss_pct,
        throughput_bytes_per_second: throughput,
        flood_kind: window.flood_kind,
    }
}

fn has_minimum_samples(report: &PhaseReport, minimum: usize) -> bool {
    report.sent >= minimum
        && report.received >= minimum
        && report.p50_ms.is_finite()
        && report.p95_ms.is_finite()
        && report.p99_ms.is_finite()
}

fn emit_metric(metric: &PerfMetric<'_>) {
    println!(
        "@@merkur-perf {}",
        serde_json::to_string(metric).expect("performance metric serializes")
    );
}

fn emit_phase_metrics(report: &PhaseReport) {
    let p50_name = format!("edge-hol-{}-ctrl-rtt-p50", report.name);
    let p95_name = format!("edge-hol-{}-ctrl-rtt-p95", report.name);
    let p99_name = format!("edge-hol-{}-ctrl-rtt-p99", report.name);
    let loss_name = format!("edge-hol-{}-ctrl-loss", report.name);
    for (name, value, percentile) in [
        (p50_name.as_str(), report.p50_ms, 0.50),
        (p95_name.as_str(), report.p95_ms, 0.95),
        (p99_name.as_str(), report.p99_ms, 0.99),
    ] {
        emit_metric(&PerfMetric {
            name,
            value,
            unit: "ms",
            direction: "lower",
            percentile: Some(percentile),
        });
    }
    emit_metric(&PerfMetric {
        name: &loss_name,
        value: report.loss_pct,
        unit: "percent",
        direction: "lower",
        percentile: None,
    });

    if !matches!(report.flood_kind, FloodKind::None) {
        let throughput_name = format!("edge-hol-{}-flood-throughput", report.name);
        emit_metric(&PerfMetric {
            name: &throughput_name,
            value: report.throughput_bytes_per_second,
            unit: "bytes/s",
            direction: "higher",
            percentile: None,
        });
    }
}

fn record_task_failure(failed: &AtomicBool, task: &'static str, error: impl std::fmt::Display) {
    failed.store(true, Ordering::Relaxed);
    eprintln!("hol_probe: {task} failed: {error}");
}

async fn run_daemon(
    conn: Arc<wtransport::Connection>,
    session_id: String,
    mode: Arc<AtomicU8>,
    failed: Arc<AtomicBool>,
    ready: oneshot::Sender<()>,
    datagram_bytes: usize,
    reliable_body_bytes: usize,
) -> Result<(), String> {
    let _preface_stream = send_preface(&conn, &session_id, "daemon")
        .await
        .map_err(|error| format!("daemon preface: {error}"))?;
    let mut ctrl_send = open_lane(&conn, CHANNEL_CTRL)
        .await
        .map_err(|error| format!("daemon CTRL lane: {error}"))?;
    let mut display_send = open_lane(&conn, CHANNEL_DISPLAY_COMMIT)
        .await
        .map_err(|error| format!("daemon display lane: {error}"))?;

    let mut ctrl_recv = tokio::time::timeout(LANE_SETUP_TIMEOUT, async {
        loop {
            let mut recv = conn
                .accept_uni()
                .await
                .map_err(|error| format!("daemon accept CTRL lane: {error}"))?;
            let mut channel = [0u8; 9];
            // The edge's empty counterpart probe can precede the browser lane.
            // Only an empty FIN is a probe; a truncated prefix remains an error.
            if recv
                .read(&mut channel[..1])
                .await
                .map_err(|error| format!("daemon read lane prefix: {error}"))?
                .is_none()
            {
                continue;
            }
            recv.read_exact(&mut channel[1..])
                .await
                .map_err(|error| format!("daemon read lane prefix: {error}"))?;
            if channel[8] == CHANNEL_CTRL {
                break Ok(recv);
            }
            break Err(format!(
                "daemon received unexpected reliable channel {}",
                channel[8]
            ));
        }
    })
    .await
    .map_err(|_| "daemon CTRL lane setup timed out".to_string())??;

    let ctrl_failed = failed.clone();
    tokio::spawn(async move {
        let result: Result<(), String> = async {
            loop {
                let body_len = read_record_header(&mut ctrl_recv)
                    .await
                    .map_err(|error| format!("CTRL ping header: {error}"))?
                    .ok_or_else(|| "CTRL ping lane finished".to_string())?;
                if body_len != 9 {
                    return Err(format!("CTRL ping body length {body_len}, expected 9"));
                }
                let mut body = [0u8; 9];
                ctrl_recv
                    .read_exact(&mut body)
                    .await
                    .map_err(|error| format!("CTRL ping body: {error}"))?;
                if body[0] != PING {
                    return Err(format!("unexpected CTRL marker {}", body[0]));
                }
                body[0] = PONG;
                write_record(&mut ctrl_send, &body)
                    .await
                    .map_err(|error| format!("CTRL pong write: {error}"))?;
            }
        }
        .await;
        if let Err(error) = result {
            record_task_failure(&ctrl_failed, "daemon CTRL lane", error);
        }
    });

    let command_conn = conn.clone();
    let command_mode = mode.clone();
    let command_failed = failed.clone();
    tokio::spawn(async move {
        loop {
            match command_conn.receive_datagram().await {
                Ok(datagram) => match datagram.payload().first().copied() {
                    Some(CMD_OFF) => command_mode.store(MODE_OFF, Ordering::Relaxed),
                    Some(CMD_DGRAM) => command_mode.store(MODE_DGRAM, Ordering::Relaxed),
                    Some(CMD_STREAM) => command_mode.store(MODE_STREAM, Ordering::Relaxed),
                    _ => {}
                },
                Err(error) => {
                    record_task_failure(&command_failed, "daemon command receiver", error);
                    return;
                }
            }
        }
    });

    let datagram_conn = conn.clone();
    let datagram_mode = mode.clone();
    let datagram_failed = failed.clone();
    tokio::spawn(async move {
        let mut payload = vec![0u8; datagram_bytes];
        payload[0] = FLOOD_DGRAM;
        loop {
            if datagram_mode.load(Ordering::Relaxed) == MODE_DGRAM {
                for _ in 0..16 {
                    if let Err(error) = datagram_conn.send_datagram(payload.clone()) {
                        record_task_failure(&datagram_failed, "daemon datagram flood", error);
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            } else {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    });

    let display_mode = mode;
    let display_failed = failed.clone();
    tokio::spawn(async move {
        let mut body = vec![0u8; reliable_body_bytes];
        body[0] = FLOOD_STREAM;
        loop {
            if display_mode.load(Ordering::Relaxed) == MODE_STREAM {
                if let Err(error) = write_record(&mut display_send, &body).await {
                    record_task_failure(&display_failed, "daemon reliable flood", error);
                    return;
                }
            } else {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    });

    let _ = ready.send(());
    conn.closed().await;
    failed.store(true, Ordering::Relaxed);
    Err("daemon connection closed before verdict".to_string())
}

async fn accept_browser_lanes(
    conn: &wtransport::Connection,
) -> Result<(wtransport::RecvStream, wtransport::RecvStream), String> {
    tokio::time::timeout(LANE_SETUP_TIMEOUT, async {
        let mut ctrl = None;
        let mut display = None;
        while ctrl.is_none() || display.is_none() {
            let mut recv = conn
                .accept_uni()
                .await
                .map_err(|error| format!("browser accept lane: {error}"))?;
            let mut channel = [0u8; 9];
            recv.read_exact(&mut channel)
                .await
                .map_err(|error| format!("browser read lane prefix: {error}"))?;
            match channel[8] {
                CHANNEL_CTRL if ctrl.is_none() => ctrl = Some(recv),
                CHANNEL_DISPLAY_COMMIT if display.is_none() => display = Some(recv),
                channel => return Err(format!("duplicate or unexpected browser lane {channel}")),
            }
        }
        Ok((
            ctrl.expect("CTRL checked present"),
            display.expect("display checked present"),
        ))
    })
    .await
    .map_err(|_| "browser lane setup timed out".to_string())?
}

async fn set_mode(conn: &wtransport::Connection, command: u8) {
    for _ in 0..5 {
        let _ = conn.send_datagram(vec![command]);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter("warn").init();

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

    let phase_ms = env_u64("HOL_PHASE_MS", 3_000).max(1);
    let settle_ms = env_u64("HOL_SETTLE_MS", 300);
    let ping_ms = env_u64("HOL_PING_MS", 50).max(1);
    let minimum_samples = env_u64("HOL_MIN_SAMPLES", 20).max(1) as usize;
    let datagram_bytes = env_u64("HOL_DGRAM_BYTES", 1_100) as usize;
    let reliable_body_bytes = env_u64("HOL_STREAM_BYTES", 32 * 1024) as usize;
    let max_p95_inflation = env_f64("HOL_MAX_P95_INFLATION_X", 3.0);
    let max_loss_pct = env_f64("HOL_MAX_LOSS_PCT", 5.0);
    if datagram_bytes == 0 || reliable_body_bytes == 0 || reliable_body_bytes > MAX_RELIABLE_BODY {
        eprintln!(
            "hol_probe: invalid flood sizes: datagram={datagram_bytes} reliable={reliable_body_bytes}"
        );
        std::process::exit(2);
    }

    let session_id = format!("hol-{}", std::process::id());
    println!(
        "hol_probe: url={url} session={session_id} phase_ms={phase_ms} ping_ms={ping_ms} \
         ping_lane=reliable-ctrl flood_lane=persistent-display min_samples={minimum_samples}"
    );
    let start = Instant::now();
    let mode = Arc::new(AtomicU8::new(MODE_OFF));
    let transport_failed = Arc::new(AtomicBool::new(false));
    let (daemon_ready_tx, daemon_ready_rx) = oneshot::channel();

    let daemon_digest = digest.clone();
    let daemon_url = url.clone();
    let daemon_session = session_id.clone();
    let daemon_mode = mode.clone();
    let daemon_failed = transport_failed.clone();
    tokio::spawn(async move {
        let result: Result<(), String> = async {
            let conn = Arc::new(
                connect(&daemon_url, daemon_digest)
                    .await
                    .map_err(|error| format!("daemon connect: {error}"))?,
            );
            run_daemon(
                conn,
                daemon_session,
                daemon_mode,
                daemon_failed.clone(),
                daemon_ready_tx,
                datagram_bytes,
                reliable_body_bytes,
            )
            .await
        }
        .await;
        if let Err(error) = result {
            record_task_failure(&daemon_failed, "daemon session", error);
        }
    });

    tokio::time::sleep(Duration::from_millis(500)).await;
    let browser = Arc::new(
        connect(&url, digest)
            .await
            .expect("browser role failed to connect"),
    );
    let _browser_preface = send_preface(&browser, &session_id, "browser")
        .await
        .expect("browser preface");
    let mut ctrl_send = open_lane(&browser, CHANNEL_CTRL)
        .await
        .expect("browser CTRL lane");
    let (mut ctrl_recv, mut display_recv) = accept_browser_lanes(&browser)
        .await
        .expect("browser persistent lanes");
    tokio::time::timeout(LANE_SETUP_TIMEOUT, daemon_ready_rx)
        .await
        .expect("daemon readiness timed out")
        .expect("daemon readiness channel closed");

    let observations: Arc<Mutex<HashMap<u64, PingObservation>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let reliable_bytes = Arc::new(AtomicU64::new(0));
    let datagram_flood_bytes = Arc::new(AtomicU64::new(0));

    let ctrl_observations = observations.clone();
    let ctrl_failed = transport_failed.clone();
    tokio::spawn(async move {
        let result: io::Result<()> = async {
            loop {
                let body_len = read_record_header(&mut ctrl_recv)
                    .await?
                    .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "CTRL lane FIN"))?;
                if body_len != 9 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("CTRL pong body length {body_len}"),
                    ));
                }
                let mut body = [0u8; 9];
                AsyncReadExt::read_exact(&mut ctrl_recv, &mut body).await?;
                if body[0] != PONG {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "unexpected CTRL pong marker",
                    ));
                }
                let id = u64::from_be_bytes(body[1..].try_into().expect("fixed pong id"));
                let received_ms = now_ms(start);
                if let Some(observation) = ctrl_observations.lock().await.get_mut(&id) {
                    observation.rtt_ms = Some(received_ms - observation.sent_ms);
                }
            }
        }
        .await;
        if let Err(error) = result {
            record_task_failure(&ctrl_failed, "browser CTRL reader", error);
        }
    });

    let display_bytes = reliable_bytes.clone();
    let display_failed = transport_failed.clone();
    tokio::spawn(async move {
        let result: io::Result<()> = async {
            let mut buffer = [0u8; RELIABLE_DRAIN_BUFFER_BYTES];
            loop {
                let body_len = read_record_header(&mut display_recv)
                    .await?
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::UnexpectedEof, "display lane FIN")
                    })?;
                let mut remaining = body_len;
                while remaining > 0 {
                    let chunk = remaining.min(buffer.len());
                    AsyncReadExt::read_exact(&mut display_recv, &mut buffer[..chunk]).await?;
                    remaining -= chunk;
                }
                display_bytes.fetch_add(
                    (RELIABLE_RECORD_HEADER_BYTES + body_len) as u64,
                    Ordering::Relaxed,
                );
            }
        }
        .await;
        if let Err(error) = result {
            record_task_failure(&display_failed, "browser display drain", error);
        }
    });

    let datagram_conn = browser.clone();
    let datagram_bytes_counter = datagram_flood_bytes.clone();
    let datagram_failed = transport_failed.clone();
    tokio::spawn(async move {
        loop {
            match datagram_conn.receive_datagram().await {
                Ok(datagram) => {
                    let payload = datagram.payload();
                    if payload.first() == Some(&FLOOD_DGRAM) {
                        datagram_bytes_counter.fetch_add(payload.len() as u64, Ordering::Relaxed);
                    }
                }
                Err(error) => {
                    record_task_failure(&datagram_failed, "browser datagram drain", error);
                    return;
                }
            }
        }
    });

    let ping_observations = observations.clone();
    let ping_failed = transport_failed.clone();
    let (ping_stop_tx, mut ping_stop_rx) = oneshot::channel();
    let ping_task = tokio::spawn(async move {
        let mut id = 1u64;
        loop {
            let sent_ms = now_ms(start);
            ping_observations.lock().await.insert(
                id,
                PingObservation {
                    sent_ms,
                    rtt_ms: None,
                },
            );
            let mut body = [0u8; 9];
            body[0] = PING;
            body[1..].copy_from_slice(&id.to_be_bytes());
            if let Err(error) = write_record(&mut ctrl_send, &body).await {
                record_task_failure(&ping_failed, "browser CTRL writer", error);
                break;
            }
            id = id.wrapping_add(1);
            tokio::select! {
                _ = &mut ping_stop_rx => break,
                _ = tokio::time::sleep(Duration::from_millis(ping_ms)) => {},
            }
        }
        ctrl_send
    });

    set_mode(&browser, CMD_OFF).await;
    tokio::time::sleep(Duration::from_millis(800)).await;

    let mut windows = Vec::new();
    for (name, command, flood_kind) in [
        ("idle", CMD_OFF, FloodKind::None),
        ("datagram-flood", CMD_DGRAM, FloodKind::Datagram),
        ("reliable-flood", CMD_STREAM, FloodKind::Reliable),
        ("recover", CMD_OFF, FloodKind::None),
    ] {
        set_mode(&browser, command).await;
        tokio::time::sleep(Duration::from_millis(settle_ms)).await;
        let start_ms = now_ms(start);
        let bytes_before = match flood_kind {
            FloodKind::None => 0,
            FloodKind::Datagram => datagram_flood_bytes.load(Ordering::Relaxed),
            FloodKind::Reliable => reliable_bytes.load(Ordering::Relaxed),
        };
        tokio::time::sleep(Duration::from_millis(phase_ms)).await;
        let end_ms = now_ms(start);
        let bytes_after = match flood_kind {
            FloodKind::None => 0,
            FloodKind::Datagram => datagram_flood_bytes.load(Ordering::Relaxed),
            FloodKind::Reliable => reliable_bytes.load(Ordering::Relaxed),
        };
        windows.push(PhaseWindow {
            name,
            start_ms,
            end_ms,
            flood_kind,
            bytes_before,
            bytes_after,
        });
    }
    set_mode(&browser, CMD_OFF).await;
    tokio::time::sleep(Duration::from_millis(ping_ms.saturating_mul(3).max(100))).await;
    let _ = ping_stop_tx.send(());
    // Keep the durable lane alive through the verdict. Aborting its writer
    // sends FIN and correctly tears down the splice, polluting failure counts.
    let _ctrl_send = ping_task.await.expect("browser CTRL writer task");

    let observations = observations.lock().await.clone();
    let reports: Vec<PhaseReport> = windows
        .iter()
        .map(|window| summarize_phase(window, &observations))
        .collect();

    println!("\n=== persistent-lane HoL report ===");
    println!(
        "{:<16} {:>6} {:>6} {:>9} {:>9} {:>9} {:>8} {:>12}",
        "phase", "sent", "recv", "p50", "p95", "p99", "loss", "throughput"
    );
    for report in &reports {
        println!(
            "{:<16} {:>6} {:>6} {:>8.1}ms {:>8.1}ms {:>8.1}ms {:>7.2}% {:>10.0}B/s",
            report.name,
            report.sent,
            report.received,
            report.p50_ms,
            report.p95_ms,
            report.p99_ms,
            report.loss_pct,
            report.throughput_bytes_per_second,
        );
    }

    let sample_failure = reports
        .iter()
        .find(|report| !has_minimum_samples(report, minimum_samples));
    if let Some(report) = sample_failure {
        eprintln!(
            "RESULT: FAIL insufficient samples for {}: sent={} received={} minimum={minimum_samples}",
            report.name, report.sent, report.received
        );
        std::process::exit(1);
    }

    for report in &reports {
        emit_phase_metrics(report);
    }

    let idle = reports
        .iter()
        .find(|report| report.name == "idle")
        .expect("idle report");
    let reliable = reports
        .iter()
        .find(|report| report.name == "reliable-flood")
        .expect("reliable report");
    let datagram = reports
        .iter()
        .find(|report| report.name == "datagram-flood")
        .expect("datagram report");
    let recovery = reports
        .iter()
        .find(|report| report.name == "recover")
        .expect("recovery report");
    let p95_inflation = reliable.p95_ms / idle.p95_ms.max(0.001);
    let recovery_inflation = recovery.p95_ms / idle.p95_ms.max(0.001);
    let passed = !transport_failed.load(Ordering::Relaxed)
        && datagram.throughput_bytes_per_second > 0.0
        && reliable.throughput_bytes_per_second > 0.0
        && reliable.loss_pct <= max_loss_pct
        && p95_inflation <= max_p95_inflation
        && recovery_inflation <= max_p95_inflation;

    println!(
        "idle_p95={:.1}ms reliable_p95={:.1}ms inflation={:.2}x \
         recovery_inflation={:.2}x reliable_loss={:.2}%",
        idle.p95_ms, reliable.p95_ms, p95_inflation, recovery_inflation, reliable.loss_pct,
    );
    if passed {
        println!("RESULT: PASS persistent reliable flood did not head-of-line block CTRL");
    } else {
        eprintln!(
            "RESULT: FAIL transport_failed={} p95_limit={max_p95_inflation:.2}x \
             loss_limit={max_loss_pct:.2}% datagram_Bps={:.0} reliable_Bps={:.0}",
            transport_failed.load(Ordering::Relaxed),
            datagram.throughput_bytes_per_second,
            reliable.throughput_bytes_per_second,
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_length_is_four_bytes_and_bounded() {
        assert_eq!(reliable_body_len(&8u32.to_be_bytes()), Some(8));
        assert_eq!(
            reliable_body_len(&(MAX_RELIABLE_BODY as u32).to_be_bytes()),
            Some(MAX_RELIABLE_BODY)
        );
        assert_eq!(
            reliable_body_len(&((MAX_RELIABLE_BODY + 1) as u32).to_be_bytes()),
            None
        );
        assert_eq!(reliable_body_len(&[0; 3]), None);
        assert_eq!(reliable_body_len(&[0; 5]), None);
    }

    #[tokio::test]
    async fn persistent_lane_writes_prefix_once_then_concatenated_records() {
        let (mut writer, mut reader) = tokio::io::duplex(64);
        writer.write_all(&[CHANNEL_CTRL]).await.unwrap();
        write_record(&mut writer, b"first").await.unwrap();
        write_record(&mut writer, b"second").await.unwrap();
        writer.shutdown().await.unwrap();

        let mut wire = Vec::new();
        reader.read_to_end(&mut wire).await.unwrap();
        assert_eq!(wire[0], CHANNEL_CTRL);
        assert_eq!(&wire[1..5], &5u32.to_be_bytes());
        assert_eq!(&wire[5..10], b"first");
        assert_eq!(&wire[10..14], &6u32.to_be_bytes());
        assert_eq!(&wire[14..], b"second");
    }

    #[test]
    fn phase_summary_reports_percentiles_loss_and_throughput() {
        let window = PhaseWindow {
            name: "test",
            start_ms: 100.0,
            end_ms: 1_100.0,
            flood_kind: FloodKind::Reliable,
            bytes_before: 10,
            bytes_after: 1_010,
        };
        let observations = HashMap::from([
            (
                1,
                PingObservation {
                    sent_ms: 200.0,
                    rtt_ms: Some(10.0),
                },
            ),
            (
                2,
                PingObservation {
                    sent_ms: 300.0,
                    rtt_ms: Some(20.0),
                },
            ),
            (
                3,
                PingObservation {
                    sent_ms: 400.0,
                    rtt_ms: None,
                },
            ),
        ]);

        let report = summarize_phase(&window, &observations);
        assert_eq!(report.sent, 3);
        assert_eq!(report.received, 2);
        assert!((report.p50_ms - 20.0).abs() < f64::EPSILON);
        assert!((report.p95_ms - 20.0).abs() < f64::EPSILON);
        assert!((report.loss_pct - 100.0 / 3.0).abs() < 0.001);
        assert!((report.throughput_bytes_per_second - 1_000.0).abs() < f64::EPSILON);
        assert!(has_minimum_samples(&report, 2));
        assert!(!has_minimum_samples(&report, 3));
    }
}
