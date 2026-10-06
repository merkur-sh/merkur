//! WebTransport accept loop and the per-session blind splice plumbing.
//!
//! Mirrors the daemon's `apps/daemon/dataplane/src/webtransport/mod.rs` accept
//! loop (same `wtransport` 0.7 API) but drops ALL NAT machinery — the edge has
//! one stable anycast address and never hole-punches. Both the browser and the
//! daemon dial **in** to this single server endpoint; they are told apart by the
//! [`RoutingPreface`] each sends first.
//!
//! Blindness: this module forwards opaque datagrams and persistent reliable lanes
//! through the [`SpliceRegistry`] without inspecting their channel or encrypted
//! body. It reads each reliable record's declared length solely for bounded
//! in-progress-byte accounting. See the module-level doc on `splice.rs`.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use merkur_edge_protocol::{
    COUNTERPART_DETACHED_CLOSE_CODE, COUNTERPART_DETACHED_CLOSE_REASON, INCARNATION_ANNOUNCED_CLOSE_CODE,
    INCARNATION_ANNOUNCED_CLOSE_REASON, INCARNATION_CHARS,
};
pub(crate) use merkur_edge_protocol::{EGRESS_BUDGET_CLOSE_CODE, EGRESS_BUDGET_CLOSE_REASON};
#[cfg(test)]
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
/// Total datagrams dropped at egress across all sessions (visibility only).
static DATAGRAM_EGRESS_DROPS: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
use liveness_tests::profile::spawn as spawn_datagram_pump;
#[cfg(not(test))]
use tokio::spawn as spawn_datagram_pump;

use tracing::{Instrument, debug, info, info_span, warn};
use wtransport::datagram::DatagramBatch;
use wtransport::endpoint::endpoint_side::Server;
use wtransport::{Endpoint, ServerConfig, VarInt};

use crate::attach_ticket::AttachTicketKey;
use crate::cert::EdgeCert;
use crate::endpoint_secret::EndpointSecret;
use crate::metrics;
use crate::splice::{
    AcceptedReliableLane, AttachError, AttachmentLifecycle, BrowserPath, ContentionRequests,
    FINITE_STREAM_FLAG, ForwardResidence, Frame, Lane, MAX_FINITE_STREAMS_PER_PEER,
    MAX_PREFACE_LEN, MAX_RELIABLE_LANES_PER_PEER, PREFACE_VERSION, RELIABLE_CHANNEL_PREFIX_BYTES,
    RELIABLE_RECORD_HEADER_BYTES, ReliableOpenedStream, ReliableRecordBudget, RetireReason, Role,
    RoutedReliableLane, RoutingAttachment, RoutingPreface, SpliceContention, SpliceControlEvent,
    SpliceDeliveryQuote, SpliceDeliveryQuoteEvent, SpliceRegistry, canonical_peer_address,
    reliable_body_len_from_header,
};

#[path = "relay_record.rs"]
mod record;
use record::RecordHead;

#[path = "relay_finite.rs"]
mod finite;

#[path = "relay_candidate.rs"]
mod candidate;

#[cfg(test)]
#[path = "relay_ownership_tests.rs"]
mod ownership_tests;

#[cfg(test)]
#[path = "relay_finite_tests.rs"]
mod finite_tests;

#[cfg(test)]
#[path = "relay_liveness_tests.rs"]
mod liveness_tests;

/// Keep-alive / idle policy mirrored from the daemon WT server.
const KEEP_ALIVE: Duration = Duration::from_secs(4);
const MAX_IDLE: Duration = Duration::from_secs(30);
/// Keep only a small newest-wins QUIC datagram window. Quinn's default 1 MiB
/// queue can turn transient edge congestion into visibly stale terminal state;
/// when this window fills Quinn evicts the oldest unsent datagrams.
const DATAGRAM_SEND_BUFFER_BYTES: usize = 64 * 1024;
const DATAGRAM_RECEIVE_BUFFER_BYTES: usize = 64 * 1024;
/// HTTP/3 control plus QPACK encoder/decoder (RFC 9114 section 6.2), in addition
/// to all application slots. The native peer currently uses only control;
/// browser peers may use all three essential streams.
const HTTP3_CONTROL_UNI_STREAMS: usize = 3;
const MAX_PEER_UNI_STREAMS: usize =
    MAX_RELIABLE_LANES_PER_PEER + MAX_FINITE_STREAMS_PER_PEER + HTTP3_CONTROL_UNI_STREAMS;

/// Latency-tuned QUIC transport parameters (mirrors
/// `tuned_quic_transport_config` in the daemon dataplane): a 100ms
/// `initial_rtt` instead of quinn's 333ms default, and the ACK-frequency
/// extension with a 5ms max ack delay so the quinn<->quinn daemon tunnel acks
/// promptly. Browsers don't negotiate the extension and are unaffected by it.
/// Congestion control stays on quinn's default (Cubic): quinn's experimental
/// BBR under-paced tiny app-limited terminal flows (typing lag) when tried.
fn tuned_quic_transport_config() -> wtransport::config::QuicTransportConfig {
    let mut config = wtransport::config::QuicTransportConfig::default();
    config
        // Every peer's connection credit before its preface names its role;
        // `finite::BulkCredit` opens or bounds it from there.
        .receive_window(
            wtransport::quinn::VarInt::from_u64(finite::BULK_CREDIT_FLOOR)
                .expect("the credit floor is a QUIC varint"),
        )
        .initial_rtt(Duration::from_millis(100))
        .datagram_send_buffer_size(DATAGRAM_SEND_BUFFER_BYTES)
        .datagram_receive_buffer_size(Some(DATAGRAM_RECEIVE_BUFFER_BYTES))
        .max_concurrent_uni_streams((MAX_PEER_UNI_STREAMS as u32).into())
        .keep_alive_interval(Some(KEEP_ALIVE))
        .max_idle_timeout(Some(
            wtransport::quinn::IdleTimeout::try_from(MAX_IDLE)
                .expect("30s is a valid idle timeout"),
        ));
    let mut ack_frequency = wtransport::quinn::AckFrequencyConfig::default();
    ack_frequency.max_ack_delay(Some(Duration::from_millis(5)));
    config.ack_frequency_config(Some(ack_frequency));
    config
}
/// Bound QUIC/WebTransport request negotiation so half-open handshakes cannot
/// pin accepted-session admission indefinitely.
const SESSION_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// A peer that connects but never sends a valid preface is dropped.
const PREFACE_TIMEOUT: Duration = Duration::from_secs(10);
/// Fixed preface on the daemon-opened delivery-quote bidirectional stream.
/// It is outside the terminal lanes and changes only with a routing-preface
/// hard cut.
const DELIVERY_QUOTE_STREAM_PREFACE: &[u8] = b"merkur-edge-quote-v1";
/// Advisory state must fail independently and quickly when the daemon stops
/// draining it. A reset here never closes lifecycle or terminal-data lanes.
const DELIVERY_QUOTE_WRITE_TIMEOUT: Duration = Duration::from_millis(500);
/// Once a lane or record starts making progress, it must finish its current
/// setup/record promptly. Idle persistent lanes are allowed to wait between
/// records; QUIC's connection idle timeout still bounds a dead carrier.
const RELIABLE_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
/// Bound each owned receive read, including lookahead across a record boundary.
const RELIABLE_READ_MAX_BYTES: usize = 16 * 1024;
const RELIABLE_READ_MAX_CHUNKS: usize = 16;
/// Prior copying implementation retained only as a test/benchmark control.
#[cfg(test)]
const RELIABLE_COPY_BUFFER_BYTES: usize = 16 * 1024;
/// Normal detach closes every pump immediately. This is only a safety valve for
/// a transport implementation that fails to wake a closed accept/read future.
const SESSION_PUMP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
/// QUIC application close code used when the edge tears a session down.
const CLOSE_CODE: u32 = 0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionExit {
    Connection,
    Control,
    Outbound,
    Datagrams,
    UniStreams,
    Registry(RetireReason),
}

impl SessionExit {
    /// Stable, low-cardinality label for the session-duration histogram.
    ///
    /// The match is exhaustive on purpose: adding a `SessionExit` or
    /// `RetireReason` variant must be a compile error here rather than
    /// silently collapsing into an `"unknown"` bucket. Distinguishing an
    /// orderly counterpart detach from a transport failure is the whole point
    /// of the label.
    fn as_metric_label(self) -> &'static str {
        match self {
            SessionExit::Connection => "connection",
            SessionExit::Control => "control",
            SessionExit::Outbound => "outbound",
            SessionExit::Datagrams => "datagrams",
            SessionExit::UniStreams => "uni_streams",
            SessionExit::Registry(RetireReason::RebindWindowExpired) => "rebind_window_expired",
            SessionExit::Registry(RetireReason::EgressBudget) => "egress_budget",
            SessionExit::Registry(RetireReason::IncarnationSuperseded) => "incarnation_superseded",
        }
    }
}

async fn settle_session_pump(
    task: &mut tokio::task::JoinHandle<()>,
    already_completed: bool,
    timeout: Duration,
    pump: &'static str,
) {
    if already_completed {
        return;
    }
    if tokio::time::timeout(timeout, &mut *task).await.is_err() {
        // Counted, not just survived. This branch is documented as a safety
        // valve for a transport that fails to wake a closed accept/read future,
        // and a claim of the form "this should not happen" is worth nothing
        // unless something says how often it does.
        metrics::record_pump_settle_timeout(pump);
        warn!(pump, "edge: session pump did not settle; aborting");
        task.abort();
        let _ = task.await;
    }
}

/// Build the browser+daemon-facing WebTransport server endpoint bound to
/// `bind_addr`. No NAT discovery: the anycast address is stable and externally
/// fixed. On Fly.io the caller passes the `fly-global-services` address (UDP
/// services must bind it, not a wildcard); locally it is the dual-stack wildcard.
pub fn build_server_config(cert: &EdgeCert, bind_addr: std::net::SocketAddr) -> ServerConfig {
    let mut tls_config =
        wtransport::tls::server::build_default_tls_config(cert.identity.clone_identity());
    // Allow 0-RTT early data for fast reconnect (mobile network handoff).
    tls_config.max_early_data_size = u32::MAX;

    ServerConfig::builder()
        .with_bind_address(bind_addr)
        .with_custom_tls_and_transport(tls_config, tuned_quic_transport_config())
        .build()
}

/// The relay with `transport` in place of its tuning: a test that must hold a
/// connection idle across a paused clock turns off its keep-alive and idle timers.
#[cfg(test)]
fn build_server_with_transport(
    cert: &EdgeCert,
    transport: wtransport::config::QuicTransportConfig,
    runtime: Arc<dyn wtransport::quinn::Runtime>,
) -> Endpoint<Server> {
    let mut tls_config =
        wtransport::tls::server::build_default_tls_config(cert.identity.clone_identity());
    tls_config.max_early_data_size = u32::MAX;
    let mut config = ServerConfig::builder()
        .with_bind_address("127.0.0.1:0".parse().expect("bind address"))
        .with_custom_tls_and_transport(tls_config, transport)
        .build();
    EndpointSecret::generate()
        .expect("secret")
        .install(config.quic_endpoint_config_mut());
    Endpoint::server_with_runtime(config, runtime).expect("test edge server")
}

/// The endpoint's secret lives in its endpoint configuration, which a
/// certificate reload never replaces: a rotation keeps every reset key and
/// connection ID valid.
pub fn build_server(
    cert: &EdgeCert,
    bind_addr: std::net::SocketAddr,
    secret: &EndpointSecret,
) -> Result<Endpoint<Server>, String> {
    let mut config = build_server_config(cert, bind_addr);
    secret.install(config.quic_endpoint_config_mut());
    Endpoint::server(config).map_err(|e| format!("failed to bind edge WebTransport server: {e}"))
}

/// Accept loop: one task per inbound session. Mirrors the daemon loop shape.
pub async fn accept_loop(
    endpoint: Arc<Endpoint<Server>>,
    registry: SpliceRegistry,
    tickets: Arc<AttachTicketKey>,
    mut budget: tokio::sync::watch::Receiver<crate::egress_budget::BudgetState>,
) {
    let cleanup_registry = registry.clone();
    tokio::spawn(async move {
        loop {
            let pruned = cleanup_registry.wait_and_prune_expired_unpaired().await;
            metrics::record_unpaired_pruned(pruned as u64);
            info!(pruned, "edge: expired half-paired splice sessions");
        }
    });

    use crate::egress_budget::BudgetState;
    registry.apply_egress_state(*budget.borrow_and_update());
    loop {
        let state = *budget.borrow();
        let admitted = async {
            if state == BudgetState::Stopped {
                // Ignore the QUIC Initial before starting TLS: unlike refuse()
                // this sends no response. Keep draining so rollover can reopen
                // this endpoint; Endpoint::close permanently ends acceptance.
                endpoint.accept().await.ignore();
                return None;
            }
            let permit = registry.acquire_session_task().await?;
            Some((endpoint.accept().await, permit))
        };
        let accepted = tokio::select! {
            biased;
            changed = budget.changed() => {
                let state = if changed.is_err() {
                    BudgetState::Stopped
                } else {
                    *budget.borrow_and_update()
                };
                registry.apply_egress_state(state);
                if changed.is_err() {
                    return;
                }
                continue;
            }
            accepted = admitted => accepted,
        };
        let Some((incoming, session_task_permit)) = accepted else {
            continue;
        };
        let registry = registry.clone();
        let tickets = Arc::clone(&tickets);
        let budget = budget.clone();

        tokio::spawn(async move {
            // Covers handshake, preface admission, attached pumps, and teardown.
            // No accepted-session task can outlive this process-wide permit.
            let _session_task_permit = session_task_permit;
            let handshake = async {
                let session_request = incoming
                    .await
                    .map_err(|error| format!("incoming session: {error}"))?;
                session_request
                    .accept()
                    .await
                    .map_err(|error| format!("session accept: {error}"))
            };
            let mut handshake_budget = budget.clone();
            let handshake_result = tokio::select! {
                biased;
                _ = handshake_budget.wait_for(|state| *state == BudgetState::Stopped) => return,
                result = tokio::time::timeout(SESSION_HANDSHAKE_TIMEOUT, handshake) => result,
            };
            let connection = match handshake_result {
                Ok(Ok(connection)) => connection,
                Ok(Err(error)) => {
                    metrics::record_handshake_failure("handshake");
                    warn!("edge: session handshake failed: {error}");
                    return;
                }
                Err(_) => {
                    metrics::record_handshake_failure("timeout");
                    warn!("edge: session handshake timed out");
                    return;
                }
            };
            let connection = Arc::new(connection);

            let session = async {
                // First step every peer performs: open a bi stream and send the
                // plaintext routing preface. The only later structured read is a
                // reliable stream's declared length for memory admission.
                let preface =
                    match tokio::time::timeout(PREFACE_TIMEOUT, read_routing_preface(&connection))
                        .await
                    {
                        Ok(Ok(p)) => p,
                        Ok(Err(e)) => {
                            metrics::record_handshake_failure("preface");
                            warn!("edge: invalid routing preface: {e}");
                            connection.close(VarInt::from_u32(CLOSE_CODE), b"bad-preface");
                            return;
                        }
                        Err(_) => {
                            metrics::record_handshake_failure("preface_timeout");
                            warn!("edge: routing preface timed out");
                            connection.close(VarInt::from_u32(CLOSE_CODE), b"preface-timeout");
                            return;
                        }
                    };

                let (preface, mut control, preface_inbound) = preface;
                // Held unread until the session ends; see `read_routing_preface`.
                let _preface_inbound = ContainedStream::new(preface_inbound);
                let state = *budget.borrow();
                if state == BudgetState::Stopped
                    || (state == BudgetState::SignalingOnly
                        && matches!(
                            preface.attachment,
                            RoutingAttachment::Primary | RoutingAttachment::Tunnel { .. }
                        )
                        && !preface.session_id.ends_with("#signaling"))
                {
                    metrics::record_handshake_failure("egress_budget");
                    connection.close(
                        VarInt::from_u32(EGRESS_BUDGET_CLOSE_CODE),
                        EGRESS_BUDGET_CLOSE_REASON,
                    );
                    return;
                }
                // Admission before the registry: an unticketed peer never holds a
                // splice slot, a candidate bridge, or a counterpart's attention.
                if let Err(error) = tickets.verify(
                    preface.role.into(),
                    &preface.daemon_id,
                    &preface.session_id,
                    &preface.ticket,
                    unix_now_secs(),
                ) {
                    metrics::record_handshake_failure("ticket");
                    warn!(role = ?preface.role, ?error, "edge: attach ticket refused");
                    connection.close(VarInt::from_u32(CLOSE_CODE), b"bad-ticket");
                    return;
                }
                let promoted = match &preface.attachment {
                    RoutingAttachment::Primary | RoutingAttachment::Tunnel { .. } => None,
                    RoutingAttachment::Announce { incarnation } => {
                        let retired = registry.announce_incarnation(&preface.daemon_id, incarnation);
                        info!(
                            daemon_id = %preface.daemon_id,
                            retired,
                            "edge: daemon incarnation announced"
                        );
                        connection.close(
                            VarInt::from_u32(INCARNATION_ANNOUNCED_CLOSE_CODE),
                            INCARNATION_ANNOUNCED_CLOSE_REASON,
                        );
                        return;
                    }
                    RoutingAttachment::Candidate { nonce } => {
                        match candidate::admit(
                            &connection,
                            &registry,
                            &preface.session_id,
                            &preface.daemon_id,
                            nonce,
                            &mut control,
                        )
                        .await
                        {
                            Ok(handle) => Some(handle),
                            Err(()) => {
                                connection.close(VarInt::from_u32(CLOSE_CODE), b"candidate-ended");
                                return;
                            }
                        }
                    }
                };
                let quote_control = if preface.role == Role::Daemon {
                    match tokio::time::timeout(
                        PREFACE_TIMEOUT,
                        read_delivery_quote_stream(&connection),
                    )
                    .await
                    {
                        Ok(Ok(stream)) => Some(stream),
                        Ok(Err(error)) => {
                            metrics::record_handshake_failure("quote_preface");
                            warn!("edge: invalid delivery-quote stream: {error}");
                            connection.close(VarInt::from_u32(CLOSE_CODE), b"bad-quote-preface");
                            return;
                        }
                        Err(_) => {
                            metrics::record_handshake_failure("quote_preface_timeout");
                            warn!("edge: delivery-quote stream timed out");
                            connection
                                .close(VarInt::from_u32(CLOSE_CODE), b"quote-preface-timeout");
                            return;
                        }
                    }
                } else {
                    None
                };
                // The remote address names the connection's path; behind the
                // harness proxy it is one relay's upstream socket, which is how a
                // run tells the relay carrying each lane apart.
                info!(
                    session_id = %preface.session_id,
                    role = ?preface.role,
                    remote = %connection.remote_address(),
                    "edge: peer attached to splice"
                );

                // Attribute names match `merkur.session.id` on the server's
                // session-issuance span; the two processes share no trace context,
                // so this is what joins a session across them.
                let session_span = info_span!(
                    "edge.session.splice",
                    "merkur.session.id" = %preface.session_id,
                    "merkur.peer.role" = ?preface.role,
                );
                run_spliced_session(
                    connection.clone(),
                    registry,
                    preface,
                    control,
                    quote_control,
                    promoted,
                )
                .instrument(session_span)
                .await;
            };
            tokio::pin!(session);
            let mut stopped = budget.clone();
            tokio::select! {
                _ = &mut session => {}
                _ = async { let _ = stopped.wait_for(|state| *state == BudgetState::Stopped).await; } => {
                    connection.close(VarInt::from_u32(EGRESS_BUDGET_CLOSE_CODE), EGRESS_BUDGET_CLOSE_REASON);
                    session.await;
                }
            }
        });
    }
}

/// Wall-clock seconds for ticket expiry, which the server stamps in its own
/// wall clock. A clock before the epoch reads as zero and so refuses nothing
/// that would otherwise pass.
fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Read the length-delimited JSON [`RoutingPreface`] from the peer's first
/// bidirectional stream. Wire layout: `u32` big-endian length, then that many
/// JSON bytes. Reads nothing else; the rest of the session is opaque.
///
/// The inbound half is returned for the session to hold unread. Dropping it
/// sends STOP_SENDING, and Firefox's WebTransport answers that by erroring the
/// stream's readable half too: the lifecycle events written back on it.
async fn read_routing_preface(
    connection: &wtransport::Connection,
) -> Result<
    (
        RoutingPreface,
        wtransport::SendStream,
        wtransport::RecvStream,
    ),
    String,
> {
    let (send, mut recv) = connection
        .accept_bi()
        .await
        .map_err(|e| format!("no preface stream: {e}"))?;

    let mut len_buf = [0u8; 4];
    recv.read_exact(&mut len_buf)
        .await
        .map_err(|e| format!("short preface length: {e}"))?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > MAX_PREFACE_LEN {
        return Err(format!("preface length {len} out of bounds"));
    }

    let mut json_buf = vec![0u8; len];
    recv.read_exact(&mut json_buf)
        .await
        .map_err(|e| format!("short preface body: {e}"))?;

    let preface = serde_json::from_slice::<RoutingPreface>(&json_buf)
        .map_err(|e| format!("preface json: {e}"))?;
    // Lifecycle always outranks advisory path telemetry at QUIC scheduling.
    send.set_priority(100);
    Ok((validate_routing_preface(preface)?, send, recv))
}

async fn read_delivery_quote_stream(
    connection: &wtransport::Connection,
) -> Result<(wtransport::SendStream, wtransport::RecvStream), String> {
    let (send, mut recv) = connection
        .accept_bi()
        .await
        .map_err(|error| format!("no delivery-quote stream: {error}"))?;
    let mut preface = [0u8; DELIVERY_QUOTE_STREAM_PREFACE.len()];
    recv.read_exact(&mut preface)
        .await
        .map_err(|error| format!("short delivery-quote preface: {error}"))?;
    if preface != DELIVERY_QUOTE_STREAM_PREFACE {
        return Err("delivery-quote preface mismatch".to_string());
    }
    // This stream is advisory and must yield to the lifecycle stream above.
    send.set_priority(-100);
    Ok((send, recv))
}

/// After its preface the daemon's quote direction carries one byte per
/// profiling change: nonzero asks for contention evidence, zero withdraws it.
/// A closed or failed stream withdraws it too, unless a successor attachment
/// has spoken since.
async fn read_contention_requests(
    mut recv: wtransport::RecvStream,
    contention: ContentionRequests,
    attachment: crate::splice::AttachmentId,
) {
    let mut request = [0u8; 1];
    while matches!(recv.read(&mut request).await, Ok(Some(1))) {
        contention.set(attachment, request[0] != 0);
    }
    contention.end(attachment);
}

/// Serialize one lifecycle event back over the preface stream.
///
/// Same `[u32 BE len][JSON]` envelope as the preface, in the reverse direction.
/// The edge is still reading and writing only the plaintext routing envelope —
/// it never inspects a data frame's channel or body — so the blind-relay
/// property is unchanged.
/// Ceiling on one splice-control write.
///
/// The write is awaited outside the lifecycle `select!`, so without a bound a
/// peer that stops draining its read half gates this relay task's own
/// close/retire handling through QUIC stream flow control. A blind relay must
/// never let a peer's read behaviour decide when it may notice its own
/// connection died. Generous relative to the payload (tens of bytes) — this is
/// a liveness bound, not a latency one.
const SPLICE_CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
async fn write_splice_control(
    control: &mut wtransport::SendStream,
    event: &SpliceControlEvent,
) -> Result<(), String> {
    write_splice_control_with_timeout(control, event, SPLICE_CONTROL_WRITE_TIMEOUT).await
}

async fn write_splice_control_with_timeout<T: serde::Serialize>(
    control: &mut wtransport::SendStream,
    event: &T,
    timeout: Duration,
) -> Result<(), String> {
    // Serialize directly into the owner QUIC will retain. The length prefix
    // and JSON share one write; neither is copied into another send buffer.
    let mut wire = Vec::with_capacity(128);
    wire.extend_from_slice(&[0u8; 4]);
    serde_json::to_writer(&mut wire, event).map_err(|e| format!("control json: {e}"))?;
    let json_len = wire.len() - 4;
    if json_len > MAX_PREFACE_LEN {
        return Err("control event too large".to_string());
    }
    let len = u32::try_from(json_len).map_err(|_| "control event too large".to_string())?;
    wire[..4].copy_from_slice(&len.to_be_bytes());
    tokio::time::timeout(timeout, control.quic_stream_mut().write_chunk(wire.into()))
        .await
        .map_err(|_| "control write timed out".to_string())?
        .map_err(|e| format!("control write: {e}"))
}

pub(crate) fn validate_routing_preface(preface: RoutingPreface) -> Result<RoutingPreface, String> {
    if preface.version != PREFACE_VERSION {
        return Err(format!("unsupported preface version {}", preface.version));
    }
    // An announcement names no session; every other attachment joins one.
    let announce = matches!(preface.attachment, RoutingAttachment::Announce { .. });
    if preface.session_id.is_empty() != announce {
        return Err(if announce {
            "announcement names a session".to_string()
        } else {
            "empty preface session id".to_string()
        });
    }
    match (&preface.attachment, preface.role) {
        (RoutingAttachment::Primary, Role::Browser) => {}
        (RoutingAttachment::Candidate { nonce }, Role::Browser)
            if preface.session_id.ends_with("#signaling") && is_base64url(nonce, 43) => {}
        (RoutingAttachment::Candidate { .. }, _) => {
            return Err("invalid candidate preface".to_string());
        }
        (
            RoutingAttachment::Tunnel { incarnation } | RoutingAttachment::Announce { incarnation },
            Role::Daemon,
        ) if is_base64url(incarnation, INCARNATION_CHARS) => {}
        _ => return Err("attachment does not match its role".to_string()),
    }
    Ok(preface)
}

fn is_base64url(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Owns a QUIC stream whose destructor must never be allowed to unwind.
///
/// `quinn::SendStream::drop` takes the connection state mutex and unwraps it
/// (`quinn-0.11.11/src/send_stream.rs:346`, via `mutex.rs`'s
/// `self.inner.lock().unwrap()`). That mutex is a `std::sync::Mutex`, so a panic
/// taken anywhere inside quinn while it is held **poisons** it, and every later
/// `SendStream::drop` on that connection unwraps the poison and panics.
///
/// A panic inside a destructor that is *already unwinding* is a non-unwinding
/// panic: the process aborts. Production has been aborting exactly this way —
/// `exit_code=134` (SIGABRT) with `oom_killed=false`, and a backtrace whose two
/// visible frames are `drop_glue::<wtransport::stream::SendStream>` called from
/// `run_spliced_session`'s poll.
///
/// That escalation contradicts the whole shape of this relay. Every spliced
/// session is its own task precisely so one peer's fault stays with that peer;
/// letting a drop take the process down instead makes a single session fatal to
/// every other session on the replica. Containing it here restores the isolation
/// the design already claims — it is not a workaround for the panic itself,
/// which still has to be found and fixed where it originates.
///
/// Generic purely so the containment itself is testable: `wtransport::SendStream`
/// cannot be made to panic on demand, but a stand-in can.
struct ContainedStream<T>(Option<T>);

impl<T> ContainedStream<T> {
    fn new(stream: T) -> Self {
        Self(Some(stream))
    }

    /// `None` only after the stream has already been released, which the drop
    /// path does exactly once and nothing reads back.
    fn get_mut(&mut self) -> Option<&mut T> {
        self.0.as_mut()
    }
}

impl<T> Drop for ContainedStream<T> {
    fn drop(&mut self) {
        let Some(stream) = self.0.take() else {
            return;
        };
        // Deliberately swallowed. Anything that escapes here during unwinding
        // aborts the process, and the stream is being discarded regardless —
        // there is no recovery to attempt, only a blast radius to contain.
        let released = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(stream)));
        if released.is_err() {
            metrics::record_contained_stream_drop_panic();
            warn!(
                "edge: contained a panic closing a splice control stream — quinn's \
                 connection mutex is poisoned, so some earlier panic went unreported"
            );
        }
    }
}

async fn next_attachment_lifecycle(
    lifecycle_rx: &mut tokio::sync::watch::Receiver<Option<AttachmentLifecycle>>,
) -> Option<AttachmentLifecycle> {
    lifecycle_rx.changed().await.ok()?;
    *lifecycle_rx.borrow_and_update()
}

async fn next_delivery_quote(
    quote_rx: &mut tokio::sync::watch::Receiver<Option<SpliceDeliveryQuote>>,
) -> Option<SpliceDeliveryQuote> {
    loop {
        quote_rx.changed().await.ok()?;
        if let Some(quote) = *quote_rx.borrow_and_update() {
            return Some(quote);
        }
        // `None` is an explicit attachment-generation fence, not closure.
        // Keep the advisory actor alive for the next browser's first sample.
    }
}

/// One FIN-acknowledged, empty WebTransport stream per counterpart generation.
/// QUIC ACKs can return even when the counterpart's data congestion window is
/// exhausted. No application payload, channel interpretation, polling or retry
/// loop is involved. Destination replacement cancels the old proof.
#[derive(Clone, Copy)]
struct CounterpartProbe {
    attachment_id: crate::splice::AttachmentId,
    // Some while pending; None only after the fresh FIN was acknowledged.
    deadline: Option<Instant>,
}

async fn probe_counterpart_transport(
    connection: Arc<wtransport::Connection>,
    mut destinations: tokio::sync::watch::Receiver<Option<crate::splice::ReliableDestination>>,
    proof: tokio::sync::watch::Sender<Option<CounterpartProbe>>,
) {
    let closed = connection.closed();
    tokio::pin!(closed);
    loop {
        let Ok((attachment_id, mut opened)) =
            wait_for_reliable_destination(closed.as_mut(), &mut destinations).await
        else {
            return;
        };
        let now = Instant::now();
        let path = opened.connection.quic_connection().stats().path;
        // The first PTO may retransmit an older in-flight packet. Allow the
        // next backed-off probe too, plus its ACK budget. These are the QUIC
        // owner's actual timers; no browser RTT estimates this leg.
        let recovery_wait = path
            .loss_detection_deadline
            .map(|deadline| deadline.saturating_duration_since(now))
            .unwrap_or_default();
        let deadline = now + recovery_wait + path.next_pto + path.pto;
        proof.send_replace(Some(CounterpartProbe {
            attachment_id,
            deadline: Some(deadline),
        }));
        let acknowledged = tokio::select! {
            biased;
            _ = closed.as_mut() => return,
            _ = destinations.changed() => false,
            result = tokio::time::timeout(RELIABLE_OPERATION_TIMEOUT, opened.send.finish()) => {
                matches!(result, Ok(Ok(())))
            },
        };
        if !destination_is_current(&destinations, attachment_id) {
            let _ = opened.send.reset(VarInt::from_u32(CLOSE_CODE));
            continue;
        }
        if acknowledged {
            proof.send_replace(Some(CounterpartProbe {
                attachment_id,
                deadline: None,
            }));
        } else {
            let _ = opened.send.reset(VarInt::from_u32(CLOSE_CODE));
        }
        // Exactly one probe per concrete attachment. Failure is not a verdict
        // about its application session; the browser owns its bounded wait.
        tokio::select! {
            _ = closed.as_mut() => return,
            changed = destinations.changed() => if changed.is_err() { return; },
        }
    }
}

// Independent newest-value state: pairing updates cannot overwrite pause/resume.
struct RelayDataControl {
    receiver: tokio::sync::watch::Receiver<crate::egress_budget::BudgetState>,
    initial: Option<bool>,
}

impl RelayDataControl {
    fn new(registry: &SpliceRegistry) -> Self {
        let mut receiver = registry.egress_changes();
        let initial = (*receiver.borrow_and_update()
            == crate::egress_budget::BudgetState::SignalingOnly)
            .then_some(true);
        Self { receiver, initial }
    }

    async fn next(&mut self) -> bool {
        use crate::egress_budget::BudgetState;
        if let Some(paused) = self.initial.take() {
            return paused;
        }
        loop {
            if self.receiver.changed().await.is_err() {
                return std::future::pending().await;
            }
            match *self.receiver.borrow_and_update() {
                BudgetState::Open => return false,
                BudgetState::SignalingOnly => return true,
                BudgetState::Stopped => {}
            }
        }
    }
}

async fn next_relay_data_state(budget: &mut Option<RelayDataControl>) -> bool {
    match budget {
        Some(budget) => budget.next().await,
        None => std::future::pending().await,
    }
}

/// Which proven browser address a signaling attachment's control stream reports.
enum PathReports {
    /// Not a signaling attachment: nothing to report.
    None,
    /// A browser's signaling attachment reports its own connection's proven
    /// address to that browser.
    Own(tokio::sync::watch::Receiver<Option<wtransport::quinn::ValidatedPath>>),
    /// A daemon's signaling attachment reports the slot's browser address.
    Counterpart(tokio::sync::watch::Receiver<Option<BrowserPath>>),
}

impl PathReports {
    /// The next event to write, once per change of the reported address.
    /// `reported` is the event last written, so a NAT rebinding that keeps the
    /// address produces nothing. The value current at the first call counts as
    /// a change, which is what writes the initial address on attach.
    async fn next(&mut self, reported: Option<SpliceControlEvent>) -> SpliceControlEvent {
        loop {
            let event = match self {
                Self::None => std::future::pending().await,
                Self::Own(path) => {
                    (*path.borrow_and_update()).map(|path| SpliceControlEvent::ObservedPath {
                        address: canonical_peer_address(path.remote.ip()),
                    })
                }
                Self::Counterpart(path) => {
                    (*path.borrow_and_update()).map(BrowserPath::control_event)
                }
            };
            if let Some(event) = event
                && Some(event) != reported
            {
                return event;
            }
            let changed = match self {
                Self::None => return std::future::pending().await,
                Self::Own(path) => path.changed().await,
                Self::Counterpart(path) => path.changed().await,
            };
            if changed.is_err() {
                return std::future::pending().await;
            }
        }
    }
}

/// Own the reverse preface stream. Only lifecycle uses this stream, so an
/// advisory path quote can neither queue nor block in front of detach/rebind.
async fn write_splice_lifecycle_controls(
    mut control: ContainedStream<wtransport::SendStream>,
    mut lifecycle_rx: tokio::sync::watch::Receiver<Option<AttachmentLifecycle>>,
    connection: &wtransport::Connection,
    mut proof_rx: tokio::sync::watch::Receiver<Option<CounterpartProbe>>,
    destinations: tokio::sync::watch::Receiver<Option<crate::splice::ReliableDestination>>,
    mut budget: Option<RelayDataControl>,
    mut paths: PathReports,
) -> Result<(), String> {
    let mut proof_open = true;
    let mut reported_path = None;
    loop {
        let lifecycle = tokio::select! {
            biased;
            next = next_relay_data_state(&mut budget) => {
                if let Some(stream) = control.get_mut() {
                    write_splice_control(stream, &SpliceControlEvent::RelayDataPaused { paused: next }).await?;
                }
                continue;
            },
            lifecycle = next_attachment_lifecycle(&mut lifecycle_rx) => {
                // The registry released this attachment. Every session ends
                // this way, after its owner has detached it and closed the
                // connection with the session's own reason: not a writer fault.
                let Some(lifecycle) = lifecycle else {
                    return Ok(());
                };
                lifecycle
            },
            changed = proof_rx.changed(), if proof_open => {
                if changed.is_err() {
                    // Probe failure carries no lifecycle verdict. Continue
                    // delivering attach/detach and the owner's exact retirement.
                    proof_open = false;
                    continue;
                }
                let proof = *proof_rx.borrow_and_update();
                if let Some(probe) = proof
                    && destination_is_current(&destinations, probe.attachment_id)
                    && let Some(stream) = control.get_mut()
                {
                    let counterpart_attachment_id = probe.attachment_id.as_u64();
                    let event = match probe.deadline {
                        Some(deadline) => SpliceControlEvent::CounterpartProbing {
                            counterpart_attachment_id,
                            wait_ms: u64::try_from(deadline.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(u64::MAX),
                        },
                        None => SpliceControlEvent::CounterpartResponsive { counterpart_attachment_id },
                    };
                    write_splice_control(stream, &event).await?;
                }
                continue;
            },
            event = paths.next(reported_path) => {
                if let Some(stream) = control.get_mut() {
                    write_splice_control(stream, &event).await?;
                }
                reported_path = Some(event);
                continue;
            },
        };
        let Some(control) = control.get_mut() else {
            return Err("splice control stream released".to_string());
        };
        match lifecycle {
            AttachmentLifecycle::Retire(_) => {
                // The session owner observes the same watch value and closes
                // with the registry-specific code. Retirement has no wire form.
                // Do not read watch closure as a writer fault and race that
                // specific close with a generic one. Keep the stream alive too:
                // dropping it here would send FIN before the owner runs. The
                // owner's close wakes us normally, without a shutdown timeout.
                connection.closed().await;
                return Ok(());
            }
            lifecycle => {
                let event = lifecycle
                    .control_event()
                    .expect("non-retirement lifecycle must have a wire event");
                write_splice_control(control, &event).await?;
            }
        }
    }
}

/// Own the independent advisory stream. A stalled reader resets only this
/// stream; terminal data and lifecycle remain live. The sender's watch cell
/// keeps the next not-yet-written quote O(1) while this write is pending.
async fn write_splice_delivery_quotes(
    mut control: ContainedStream<wtransport::SendStream>,
    mut quote_rx: tokio::sync::watch::Receiver<Option<SpliceDeliveryQuote>>,
) -> Result<(), String> {
    loop {
        let Some(quote) = next_delivery_quote(&mut quote_rx).await else {
            return Err("splice delivery quote closed".to_string());
        };
        let Some(stream) = control.get_mut() else {
            return Err("splice delivery quote stream released".to_string());
        };
        if let Err(error) = write_splice_control_with_timeout(
            stream,
            &SpliceDeliveryQuoteEvent::from(quote),
            DELIVERY_QUOTE_WRITE_TIMEOUT,
        )
        .await
        {
            let _ = stream.reset(VarInt::from_u32(CLOSE_CODE));
            return Err(error);
        }
    }
}

/// Attach the peer to the registry and pump opaque frames in both directions
/// until the session closes. Received payload owners pass through without inspection.
async fn run_spliced_session(
    connection: Arc<wtransport::Connection>,
    registry: SpliceRegistry,
    preface: RoutingPreface,
    control: wtransport::SendStream,
    quote_control: Option<(wtransport::SendStream, wtransport::RecvStream)>,
    promoted: Option<crate::splice::AttachHandle>,
) {
    let budget = preface
        .session_id
        .ends_with("#signaling")
        .then(|| RelayDataControl::new(&registry));
    let mut control = ContainedStream::new(control);
    // Reliable ingress fans out one task per accepted uni-stream. Keep the
    // routing label in shared immutable storage so that fan-out only bumps a
    // reference count instead of allocating and copying the String per frame.
    let session_id: Arc<str> = preface.session_id.into();
    let role = preface.role;

    let attached = match (promoted, &preface.attachment) {
        (Some(handle), _) => Ok(handle),
        (None, RoutingAttachment::Tunnel { incarnation }) => {
            registry.attach_tunnel(&session_id, &preface.daemon_id, incarnation)
        }
        (None, _) => registry.attach(&session_id, role, &preface.daemon_id),
    };
    let handle = match attached {
        Ok(handle) => handle,
        Err(error) => {
            let (outcome, reason): (&str, &[u8]) = match error {
                AttachError::EgressBudget => {
                    metrics::record_handshake_failure("egress_budget");
                    ("egress_budget", b"egress-budget")
                }
                AttachError::DaemonMismatch => ("daemon_mismatch", b"splice-daemon-mismatch"),
                AttachError::Capacity | AttachError::CounterpartChanged => {
                    ("capacity", b"splice-capacity")
                }
            };
            metrics::record_attach(role.as_metric_label(), outcome);
            warn!(session_id = %session_id, role = ?role, ?error, "edge: splice attach rejected");
            let code = if error == AttachError::EgressBudget {
                EGRESS_BUDGET_CLOSE_CODE
            } else {
                CLOSE_CODE
            };
            connection.close(VarInt::from_u32(code), reason);
            return;
        }
    };
    if let Some(stale) = handle.replaced {
        let resumed = stale.resume_successor(connection.quic_connection());
        debug!(session_id = %session_id, role = ?role, resumed, "edge: displaced stale same-role peer");
        stale.retire_replaced();
    }
    registry.bind_transport(
        &session_id,
        role,
        handle.attachment_id,
        connection.quic_connection(),
    );
    if role == Role::Daemon && session_id.ends_with("#signaling") {
        registry.bind_candidate_target(&session_id, handle.attachment_id, &connection);
    }
    // Routing labels select credit as they select priority; no content
    // authority. Before the preface every connection had only the floor.
    let daemon_bulk = finite::attach_receive_credit(
        connection.quic_connection(),
        role,
        session_id.ends_with("#bulk"),
    );
    metrics::record_attach(role.as_metric_label(), "ok");
    let attached_at = Instant::now();
    if handle.both_attached {
        info!(session_id = %session_id, "edge: splice complete (browser <-> daemon paired)");
    }
    // The arriving peer's pairing verdict, before any pump starts, so it can
    // rely on "first control event = my counterpart's presence". The registry
    // computed it under the same lock that seated this attachment, so it is not
    // a race — and the alternative is the peer inferring it from a timeout.
    if let Some(control) = control.get_mut()
        && let Err(error) = write_splice_control(
            control,
            &SpliceControlEvent::CounterpartPresent {
                present: handle.both_attached,
                counterpart_attachment_id: handle
                    .counterpart_attachment_id
                    .map(|attachment_id| attachment_id.as_u64()),
            },
        )
        .await
    {
        warn!(session_id = %session_id, "edge: splice presence write failed: {error}");
        registry.detach(&session_id, role, handle.attachment_id);
        return;
    }
    let mut datagram_rx = handle.datagram_rx;
    let mut reliable_open_rx = handle.reliable_open_rx;
    let mut lifecycle_rx = handle.lifecycle_rx;
    let control_lifecycle_rx = lifecycle_rx.clone();
    let control_quote_rx = handle.delivery_quote_rx;
    let attachment_id = handle.attachment_id;
    // The browser's proven address, from its QUIC connection's path validation.
    // Only the signaling attachment's is the browser's network identity: data
    // lanes are separate flows a pooled NAT may give other addresses. Every
    // browser lane still logs its moves.
    let signaling = session_id.ends_with("#signaling");
    let mut own_path = connection.quic_connection().validated_path();
    let mut reported_address =
        (*own_path.borrow_and_update()).map(|path| canonical_peer_address(path.remote.ip()));
    if role == Role::Browser
        && signaling
        && let Some(address) = reported_address
    {
        registry.publish_browser_path(&session_id, attachment_id, address);
    }
    let paths = match (role, signaling) {
        (Role::Browser, true) => PathReports::Own(own_path.clone()),
        (Role::Daemon, true) => PathReports::Counterpart(handle.browser_path),
        _ => PathReports::None,
    };
    let mut quote_interval = tokio::time::interval(Duration::from_millis(100));
    quote_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // The driver republishes this on each change, so a browser leg that stops
    // or resumes delivering is quoted within one relay turn, not one tick.
    let mut send_blocked = connection.quic_connection().send_blocked();

    // The arriving peer's presence record was written synchronously above and
    // is therefore always first. All subsequent control writes live in their
    // own bounded newest-value actors on independent streams so a
    // flow-controlled quote never blocks connection close, retirement, or the
    // data pumps.
    let control_connection = connection.clone();
    let destinations = handle.counterpart_destinations;
    let (proof_tx, proof_rx) = tokio::sync::watch::channel(None);
    let probe_connection = connection.clone();
    let probe_destinations = destinations.clone();
    let mut counterpart_probe = tokio::spawn(async move {
        if role == Role::Browser {
            probe_counterpart_transport(probe_connection, probe_destinations, proof_tx).await;
        } else {
            // Keep the sender alive until the lifecycle owner closes.
            probe_connection.closed().await;
            drop(proof_tx);
        }
    });
    let mut control_writer = tokio::spawn(async move {
        if let Err(error) = write_splice_lifecycle_controls(
            control,
            control_lifecycle_rx,
            &control_connection,
            proof_rx,
            destinations,
            budget,
            paths,
        )
        .await
        {
            warn!("edge: splice control writer failed: {error}");
            control_connection.close(VarInt::from_u32(CLOSE_CODE), b"splice-control-ended");
        }
    });
    let contention = handle.contention;
    let quote_contention = contention.clone();
    let mut quote_writer = tokio::spawn(async move {
        // Only a daemon opens the quote stream. A browser's writer ends here,
        // so teardown finds it settled instead of waiting out the safety valve.
        let Some((quote_control, contention_requests)) = quote_control else {
            return;
        };
        let (written, ()) = tokio::join!(
            write_splice_delivery_quotes(ContainedStream::new(quote_control), control_quote_rx),
            read_contention_requests(contention_requests, quote_contention, attachment_id),
        );
        if let Err(error) = written {
            // Advisory-lane failure is isolated to that lane. Lifecycle and
            // terminal traffic stay healthy and planning becomes conservative.
            debug!("edge: delivery-quote writer ended: {error}");
        }
    });

    // Residence of the daemon's datagrams at this relay, reported with the
    // browser-facing quote while the daemon asks for it. The daemon-facing
    // direction has no quote to carry it, so its pump records nothing.
    let forward_residence = Arc::new(ForwardResidence::default());
    let outbound_residence = (role == Role::Browser).then(|| Arc::clone(&forward_residence));
    let timed_ingress = (role == Role::Daemon).then(|| contention.clone());

    // Task A: drain datagrams addressed to THIS peer and serve stream-open
    // requests from source-owned reliable-lane actors. The returned SendStream
    // moves to the source actor; no destination task owns a source RecvStream.
    let outbound_conn = connection.clone();
    let outbound_registry = registry.clone();
    let outbound_session = Arc::clone(&session_id);
    let mut outbound = spawn_datagram_pump(async move {
        let mut opening_tasks = tokio::task::JoinSet::new();
        let mut datagrams_open = true;
        let mut requests_open = true;
        while datagrams_open || requests_open || !opening_tasks.is_empty() {
            // Registry detach/replacement drops both senders. Do not drain a
            // stale peer's buffered mailbox or wait for a write slot before
            // noticing closure.
            if datagrams_open && datagram_rx.is_closed() {
                datagrams_open = false;
            }
            if requests_open && reliable_open_rx.is_closed() {
                requests_open = false;
            }
            if !datagrams_open && !requests_open && opening_tasks.is_empty() {
                break;
            }
            tokio::select! {
                _ = opening_tasks.join_next(), if !opening_tasks.is_empty() => {},
                frame = datagram_rx.recv(), if datagrams_open => match frame {
                    Some(mut frame) => {
                        debug_assert!(matches!(frame.lane, Lane::Datagram));
                    // Best-effort lane, but drops must be VISIBLE: correlated
                    // bursts here take a flush's data AND its FEC repair
                    // shards together, defeating k=1 FEC end to end and
                    // surfacing as NACK/repair latency tails on keystrokes.
                    //
                    // Drop HERE so egress pressure remains visible rather than
                    // relying on quinn's implicit oldest-first eviction.
                    // One atomic non-dropping admission per datagram, with no
                    // envelope copy or separate advisory connection-lock pass.
                    // The hold keeps the peer's driver from building a packet
                    // until the whole batch is queued, so datagrams that arrived
                    // in one packet leave in one. A lone datagram has nothing to
                    // wait for: its own admission wakes the driver.
                    let received_at = frame.received_at;
                    let _hold = (frame.datagrams.len() > 1).then(|| outbound_conn.hold_egress());
                    for payload in frame.datagrams.drain() {
                        if payload.is_empty() {
                            continue;
                        }
                        if outbound_conn.send_datagram_owned(payload).is_ok() {
                            #[cfg(test)]
                            if let Some(received_at) = received_at {
                                liveness_tests::profile::residence(received_at);
                            }
                            if let (Some(residence), Some(received_at)) =
                                (&outbound_residence, received_at)
                            {
                                residence.record(received_at.elapsed());
                            }
                        } else {
                            metrics::record_datagram_egress_drop();
                            let dropped =
                                DATAGRAM_EGRESS_DROPS.fetch_add(1, Ordering::Relaxed) + 1;
                            if dropped.is_power_of_two() || dropped.is_multiple_of(1000) {
                                warn!(
                                    total = dropped,
                                    "edge: datagram egress dropped (backpressure)"
                                );
                            }
                        }
                    }
                    }
                    None => datagrams_open = false,
                },
                request = reliable_open_rx.recv(), if requests_open => {
                    let Some(request) = request else {
                        requests_open = false;
                        continue;
                    };
                    if request.finite && !outbound_registry.coordinate_egress(&outbound_session, role, attachment_id, true) {
                        let _ = request.reply.send(None);
                        continue;
                    }
                    let conn = outbound_conn.clone();
                    opening_tasks.spawn(async move {
                        let crate::splice::ReliableOpenRequest { finite, mut reply, waiting } =
                            request;
                        let opening = async {
                            let open =
                                tokio::time::timeout(RELIABLE_OPERATION_TIMEOUT, conn.open_uni());
                            tokio::pin!(open);
                            // An open that cannot complete at once waits for
                            // stream credit: say so before waiting.
                            let first = std::future::poll_fn(|cx| {
                                std::task::Poll::Ready(open.as_mut().poll(cx))
                            })
                            .await;
                            let opened = match first {
                                std::task::Poll::Ready(opened) => opened,
                                std::task::Poll::Pending => {
                                    if let Some(waiting) = waiting {
                                        let _ = waiting.send(());
                                    }
                                    open.await
                                }
                            };
                            match opened {
                                Ok(Ok(opening)) => {
                                    match tokio::time::timeout(RELIABLE_OPERATION_TIMEOUT, opening)
                                        .await
                                    {
                                        Ok(Ok(send)) => Some(ReliableOpenedStream {
                                            send,
                                            connection: conn.clone(),
                                        }),
                                        _ => None,
                                    }
                                }
                                _ => None,
                            }
                        };
                        let stream = tokio::select! {
                            biased;
                            _ = reply.closed() => return,
                            stream = opening => stream,
                        };
                        if stream.is_none() && !finite {
                            metrics::record_reliable_write_timeout();
                            conn.close(
                                VarInt::from_u32(CLOSE_CODE),
                                b"reliable-destination-open-failed",
                            );
                        }
                        if let Err(Some(mut opened)) = reply.send(stream) {
                            let _ = opened.send.reset(VarInt::from_u32(0));
                        }
                    });
                },
            }
        }
        opening_tasks.shutdown().await;
    });

    // Task B: read THIS peer's inbound datagrams and route them to the peer.
    let datagram_route = handle.datagram_route;
    let dgram_conn = connection.clone();
    let mut datagrams = spawn_datagram_pump(async move {
        // Payloads are zero-copy Bytes slices backed by wtransport's receive
        // allocation. The frame retains them through routing and egress. One
        // read takes every datagram already received, so a packet's datagrams
        // travel as one frame and egress admits them together.
        let mut batch = DatagramBatch::default();
        while dgram_conn.receive_datagrams(&mut batch).await.is_ok() {
            // A daemon's datagram starts its relay residence only while the
            // daemon asks for it; otherwise relaying reads no clock.
            let timed = timed_ingress
                .as_ref()
                .is_some_and(ContentionRequests::asked);
            #[cfg(test)]
            let timed = timed || liveness_tests::profile::ACTIVE.load(Ordering::Relaxed);
            let received = std::mem::take(&mut batch);
            datagram_route.route(if timed {
                Frame::timed_datagrams(received)
            } else {
                Frame::datagrams(received)
            });
        }
    });

    // Task C: own every accepted source stream for the complete source
    // attachment. Each lane actor follows the role-stable destination watch and
    // rotates only its writer when the counterpart is replaced.
    let uni_registry = registry.clone();
    let uni_conn = connection.clone();
    let uni_session = Arc::clone(&session_id);
    let mut uni_streams = tokio::spawn(async move {
        let lane_slots = Arc::new(tokio::sync::Semaphore::new(
            MAX_RELIABLE_LANES_PER_PEER + MAX_FINITE_STREAMS_PER_PEER,
        ));
        let durable_slots = Arc::new(tokio::sync::Semaphore::new(MAX_RELIABLE_LANES_PER_PEER));
        let finite_slots = Arc::new(tokio::sync::Semaphore::new(MAX_FINITE_STREAMS_PER_PEER));
        let mut lane_tasks = tokio::task::JoinSet::new();
        let closed = uni_conn.closed();
        tokio::pin!(closed);
        loop {
            let permit = tokio::select! {
                finished = lane_tasks.join_next(), if !lane_tasks.is_empty() => {
                    if let Some(Err(error)) = finished {
                        warn!(?error, "edge: reliable lane actor panicked");
                        uni_conn.close(VarInt::from_u32(CLOSE_CODE), b"reliable-lane-panicked");
                    }
                    continue;
                },
                permit = lane_slots.clone().acquire_owned() => match permit {
                    Ok(permit) => permit,
                    Err(_) => break,
                },
                _ = &mut closed => break,
            };
            let accepted = tokio::select! {
                biased;
                _ = &mut closed => break,
                accepted = uni_conn.accept_uni() => accepted,
            };
            match accepted {
                Ok(recv) => {
                    let lane = AcceptedReliableLane::new(recv, uni_conn.clone(), permit);
                    let Some(lane) =
                        uni_registry.bind_reliable_lane(&uni_session, role, attachment_id, lane)
                    else {
                        warn!("edge: persistent reliable lane admission failed");
                        break;
                    };
                    let durable_slots = Arc::clone(&durable_slots);
                    let finite_slots = Arc::clone(&finite_slots);
                    lane_tasks.spawn(async move {
                        let mut lane = lane;
                        let source = lane.source_connection.clone();
                        let mut prefix = [0; RELIABLE_CHANNEL_PREFIX_BYTES];
                        let read = tokio::time::timeout(
                            RELIABLE_OPERATION_TIMEOUT,
                            lane.recv.read_exact(&mut prefix),
                        )
                        .await;
                        if !matches!(read, Ok(Ok(()))) {
                            // No durable lane has been claimed. A cancelled
                            // finite open may reset before its lifecycle byte.
                            return;
                        }
                        if prefix[0] & FINITE_STREAM_FLAG != 0 {
                            let Ok(_class_permit) = finite_slots.try_acquire_owned() else {
                                return;
                            };
                            finite::forward(lane, prefix, daemon_bulk).await;
                            return;
                        }
                        let Ok(_class_permit) = durable_slots.try_acquire_owned() else {
                            source.close(VarInt::from_u32(CLOSE_CODE), b"reliable-lane-capacity");
                            return;
                        };
                        let result = forward_reliable_lane(lane, prefix).await;
                        if let Err(error) = result {
                            if matches!(error, ReliableLaneError::SourceTimeout) {
                                metrics::record_reliable_write_timeout();
                            }
                            warn!(?error, "edge: persistent reliable lane ended");
                            if error.implicates_source() {
                                source.close(
                                    VarInt::from_u32(CLOSE_CODE),
                                    b"reliable-source-lane-ended",
                                );
                            }
                        }
                    });
                }
                Err(_) => break,
            }
        }
        lane_tasks.shutdown().await;
    });

    // What the detach record says about how a browser leg died, maintained on
    // the quote tick that already reads that connection's statistics: when the
    // browser last delivered a UDP datagram (to the tick). No clock is read per
    // datagram, and a daemon leg gains no statistics read.
    let mut uplink_datagrams = 0u64;
    let mut uplink_delivered_at = attached_at;
    let mut watching_path = role == Role::Browser;
    // How the connection itself ended, when that is what ended the session.
    // wtransport closes the QUIC connection locally once the peer ends the
    // WebTransport session, so only this result names the peer's close.
    let mut ended_by: Option<wtransport::error::ConnectionError> = None;
    let connection_closed = connection.closed();
    tokio::pin!(connection_closed);

    // A displaced sink closes its outbound receiver. Treat that like any other
    // pump failure so the stale transport cannot linger and send more frames.
    // Only a registry `Retire` ends the session. Pairing transitions are
    // forwarded to the peer and the loop continues: a browser carrier dying now
    // leaves the slot half-paired so the browser can come back to the daemon
    // tunnel that never left, and the daemon needs to hear about it without
    // losing that tunnel.
    let exit = loop {
        let lifecycle = tokio::select! {
            biased;
            lifecycle = next_attachment_lifecycle(&mut lifecycle_rx) => match lifecycle {
                Some(event) => event,
                None => break SessionExit::Outbound,
            },
            error = &mut connection_closed => {
                ended_by = Some(error);
                break SessionExit::Connection;
            }
            _ = &mut control_writer => break SessionExit::Control,
            _ = &mut outbound => break SessionExit::Outbound,
            _ = &mut datagrams => break SessionExit::Datagrams,
            _ = &mut uni_streams => break SessionExit::UniStreams,
            changed = own_path.changed(), if watching_path => {
                if changed.is_err() {
                    watching_path = false;
                    continue;
                }
                let Some(path) = *own_path.borrow_and_update() else {
                    continue;
                };
                // Announced only once the browser answered on the new path, so
                // a spoofed or abandoned move never reaches the log or the daemon.
                let address = canonical_peer_address(path.remote.ip());
                let moved = reported_address != Some(address);
                info!(
                    session_id = %session_id,
                    attachment = attachment_id.as_u64(),
                    kind = if moved { "address" } else { "rebind" },
                    sequence = path.sequence,
                    "edge: peer path validated"
                );
                if moved {
                    reported_address = Some(address);
                    if signaling {
                        registry.publish_browser_path(&session_id, attachment_id, address);
                    }
                }
                continue;
            },
            _ = quote_interval.tick(), if role == Role::Browser => {
                let quic = connection.quic_connection();
                let stats = quic.stats();
                if stats.udp_rx.datagrams != uplink_datagrams {
                    uplink_datagrams = stats.udp_rx.datagrams;
                    uplink_delivered_at = Instant::now();
                }
                // A leg that stops delivering is quoted, never closed: its
                // attachment ends only on a replacement, the peer's close, a
                // verified reset or the idle timeout, and the daemon plans
                // around it from the quote.
                if role == Role::Browser {
                    registry.report_delivery_quote(
                        &session_id,
                        role,
                        attachment_id,
                        browser_delivery_quote(
                            attachment_id,
                            quic,
                            &stats,
                            &contention,
                            &forward_residence,
                        ),
                    );
                }
                continue;
            },
            Ok(()) = send_blocked.changed(), if role == Role::Browser => {
                let quic = connection.quic_connection();
                if *send_blocked.borrow_and_update() {
                    // Only probes may leave this leg. Its queued display
                    // datagrams could only arrive stale; a newer frame or the
                    // daemon's display cache repairs what they carried.
                    let superseded = quic.clear_queued_datagrams();
                    if superseded != 0 {
                        metrics::record_datagrams_superseded(superseded as u64);
                        info!(
                            session_id = %session_id,
                            attachment = attachment_id.as_u64(),
                            superseded,
                            "edge: browser leg blocked; discarded its queued datagrams"
                        );
                    }
                }
                let stats = quic.stats();
                registry.report_delivery_quote(
                    &session_id,
                    role,
                    attachment_id,
                    browser_delivery_quote(
                        attachment_id,
                        quic,
                        &stats,
                        &contention,
                        &forward_residence,
                    ),
                );
                continue;
            },
        };
        if let AttachmentLifecycle::Retire(reason) = lifecycle {
            break SessionExit::Registry(reason);
        }
    };
    // For any other exit, read before this side closes it, or every cause would
    // read as local.
    let (cause, peer_close_code) = match &ended_by {
        Some(error) => session_close_cause(error),
        None => close_cause(connection.quic_connection().close_reason()),
    };
    let uplink_silent_ms =
        (role == Role::Browser).then(|| uplink_delivered_at.elapsed().as_millis());
    let (close_code, close_reason) = match exit {
        SessionExit::Registry(RetireReason::EgressBudget) => {
            (EGRESS_BUDGET_CLOSE_CODE, EGRESS_BUDGET_CLOSE_REASON)
        }
        SessionExit::Registry(
            RetireReason::RebindWindowExpired | RetireReason::IncarnationSuperseded,
        ) => (
            COUNTERPART_DETACHED_CLOSE_CODE,
            COUNTERPART_DETACHED_CLOSE_REASON,
        ),
        _ => (CLOSE_CODE, b"splice-ended".as_slice()),
    };
    connection.close(VarInt::from_u32(close_code), close_reason);
    // Remove the sink first. This closes both outbound mailboxes, waking that
    // pump without asking it to drain frames for a dead/replaced transport.
    registry.detach(&session_id, role, attachment_id);

    // Let each pump take its normal exit path. The outbound lane JoinSet is
    // explicitly shut down so all stream and record permits are released before
    // the accepted-session admission slot is returned.
    let quote_writer_completed = quote_writer.is_finished();
    let counterpart_probe_completed = counterpart_probe.is_finished();
    tokio::join!(
        settle_session_pump(
            &mut counterpart_probe,
            counterpart_probe_completed,
            SESSION_PUMP_SHUTDOWN_TIMEOUT,
            "counterpart_probe",
        ),
        settle_session_pump(
            &mut outbound,
            exit == SessionExit::Outbound,
            SESSION_PUMP_SHUTDOWN_TIMEOUT,
            "outbound",
        ),
        settle_session_pump(
            &mut datagrams,
            exit == SessionExit::Datagrams,
            SESSION_PUMP_SHUTDOWN_TIMEOUT,
            "datagrams",
        ),
        settle_session_pump(
            &mut uni_streams,
            exit == SessionExit::UniStreams,
            SESSION_PUMP_SHUTDOWN_TIMEOUT,
            "uni_streams",
        ),
        settle_session_pump(
            &mut control_writer,
            exit == SessionExit::Control,
            SESSION_PUMP_SHUTDOWN_TIMEOUT,
            "control",
        ),
        settle_session_pump(
            &mut quote_writer,
            quote_writer_completed,
            SESSION_PUMP_SHUTDOWN_TIMEOUT,
            "delivery_quote",
        ),
    );
    // One `stats()` read per peer, per session, on a connection that has already
    // been closed and whose pumps have settled. This takes the per-connection
    // state mutex the QUIC driver holds during packet I/O, which is exactly why
    // it lives here and never on a frame path.
    //
    // `frame_tx.datagram` is the forwarded-datagram denominator that makes the
    // egress and mailbox drop counters interpretable as a ratio, and
    // `path.lost_packets` less `path.spurious_lost_packets` (declared lost, then
    // acknowledged after all) is the only true packet-loss signal available
    // anywhere in Merkur. Nothing here inspects a payload or a channel byte, so
    // the relay stays blind.
    let stats = connection.quic_connection().stats();
    let exit_label = exit.as_metric_label();
    metrics::record_session_quic_stats(role.as_metric_label(), &stats);
    metrics::record_session_duration(
        role.as_metric_label(),
        exit_label,
        attached_at.elapsed().as_secs_f64() * 1_000.0,
    );

    let delivery = connection.quic_connection().delivery_state();
    info!(
        session_id = %session_id,
        role = ?role,
        lane = lane_of(&session_id),
        attachment = attachment_id.as_u64(),
        exit = exit_label,
        cause,
        peer_close_code,
        uplink_silent_ms = ?uplink_silent_ms,
        lifetime_ms = attached_at.elapsed().as_millis(),
        peer_rebinds = delivery.peer_rebinds,
        peer_address_changes = delivery.peer_address_changes,
        pto_count = delivery.pto_count,
        rtt_ms = stats.path.rtt.as_secs_f64() * 1_000.0,
        datagrams_rx = stats.frame_rx.datagram,
        datagrams_tx = stats.frame_tx.datagram,
        packets_sent = stats.path.sent_packets,
        packets_lost = stats.path.lost_packets - stats.path.spurious_lost_packets,
        "edge: peer detached"
    );
}

/// Which of a session's three connections this is, from its routing label.
fn lane_of(session_id: &str) -> &'static str {
    if session_id.ends_with("#signaling") {
        "signaling"
    } else if session_id.ends_with("#bulk") {
        "bulk"
    } else {
        "interactive"
    }
}

/// How the connection ended, as its WebTransport session reported it, and the
/// peer's close code when the peer closed it.
fn session_close_cause(error: &wtransport::error::ConnectionError) -> (&'static str, u64) {
    use wtransport::error::ConnectionError;
    match error {
        ConnectionError::ApplicationClosed(close) => {
            ("peer_application_closed", close.code().into_inner())
        }
        ConnectionError::ConnectionClosed(_) => ("peer_connection_closed", 0),
        ConnectionError::TimedOut => ("idle_timeout", 0),
        ConnectionError::LocallyClosed => ("locally_closed", 0),
        ConnectionError::LocalH3Error(_) => ("local_h3_error", 0),
        ConnectionError::QuicProto(_) => ("transport_error", 0),
        ConnectionError::CidsExhausted => ("cids_exhausted", 0),
    }
}

/// Why the connection ended, as its QUIC state recorded it, and the peer's
/// close code when the peer closed it. `open` is a session this relay ended
/// (a replacement, a retirement, a pump failure) on a connection that was
/// still up.
fn close_cause(error: Option<wtransport::quinn::ConnectionError>) -> (&'static str, u64) {
    use wtransport::quinn::ConnectionError;
    match error {
        None => ("open", 0),
        Some(ConnectionError::TimedOut) => ("idle_timeout", 0),
        Some(ConnectionError::ApplicationClosed(close)) => {
            ("peer_application_closed", close.error_code.into_inner())
        }
        Some(ConnectionError::ConnectionClosed(close)) => {
            ("peer_connection_closed", u64::from(close.error_code))
        }
        Some(ConnectionError::Reset) => ("reset", 0),
        Some(ConnectionError::LocallyClosed) => ("locally_closed", 0),
        Some(ConnectionError::TransportError(_)) => ("transport_error", 0),
        Some(ConnectionError::VersionMismatch) => ("version_mismatch", 0),
        Some(ConnectionError::CidsExhausted) => ("cids_exhausted", 0),
    }
}

/// This browser attachment's QUIC state, as its paired daemon plans against it.
fn browser_delivery_quote(
    attachment_id: crate::splice::AttachmentId,
    quic: &wtransport::quinn::Connection,
    stats: &wtransport::quinn::ConnectionStats,
    contention: &ContentionRequests,
    forward_residence: &ForwardResidence,
) -> SpliceDeliveryQuote {
    SpliceDeliveryQuote {
        browser_attachment_id: attachment_id.as_u64(),
        rtt_us: stats.path.rtt.as_micros().min(u128::from(u64::MAX)) as u64,
        congestion_window_bytes: stats.path.cwnd,
        bytes_in_flight: stats
            .path
            .bytes_in_flight
            .saturating_sub(stats.path.image_bytes_in_flight),
        send_buffer_occupied_bytes: DATAGRAM_SEND_BUFFER_BYTES
            .saturating_sub(quic.delivery_state().datagram_send_buffer_space)
            as u64,
        mtu_bytes: stats.path.current_mtu,
        pacing_rate_bps: stats.path.pacing_rate.unwrap_or(0),
        sent_packets: stats.path.sent_packets,
        lost_packets: stats.path.lost_packets - stats.path.spurious_lost_packets,
        // Constant while nobody asks, so never material then.
        contention: if contention.asked() {
            SpliceContention::new(
                quic.egress_group().map(|group| group.stats()),
                forward_residence.snapshot(),
            )
        } else {
            SpliceContention::default()
        },
        pto_count: stats.path.pto_count,
        send_blocked: stats.path.send_blocked,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReliableLaneError {
    DestinationStopped,
    #[cfg(test)]
    PrefixRead,
    #[cfg(test)]
    PrefixWrite,
    SourceFin,
    HeaderRead,
    InvalidLength,
    BudgetClosed,
    BodyRead,
    #[cfg(test)]
    HeaderWrite,
    #[cfg(test)]
    BodyWrite,
    /// A bounded read/drain/budget operation on the source stalled. Separate
    /// from destination timeout because only this one retires the source
    /// attachment.
    SourceTimeout,
    /// Test-helper timeout. Production destination writes handle their exact
    /// connection inline and production source waits use `SourceTimeout`.
    #[cfg(test)]
    Timeout,
}

impl ReliableLaneError {
    /// Whether the failure implicates the peer this lane was reading FROM.
    ///
    /// This distinction is what keeps a browser carrier loss from tearing down
    /// the daemon's connection. A destination-side failure means the peer we
    /// were writing to is gone — which during a rebind window is the expected
    /// state, not a fault of the source — so the source keeps its transport and
    /// its half of the splice, and re-opens a lane when the counterpart
    /// returns. Only a genuine source-side fault ends the source connection.
    fn implicates_source(self) -> bool {
        match self {
            Self::SourceFin
            | Self::HeaderRead
            | Self::InvalidLength
            | Self::BodyRead
            | Self::BudgetClosed
            | Self::SourceTimeout => true,
            #[cfg(test)]
            Self::PrefixRead => true,
            Self::DestinationStopped => false,
            #[cfg(test)]
            Self::PrefixWrite | Self::HeaderWrite | Self::BodyWrite | Self::Timeout => false,
        }
    }
}

async fn forward_reliable_lane(
    lane: RoutedReliableLane,
    channel: [u8; RELIABLE_CHANNEL_PREFIX_BYTES],
) -> Result<(), ReliableLaneError> {
    let RoutedReliableLane {
        source_attachment_id,
        mut recv,
        source_connection,
        _lane_permit,
        direction_budget,
        global_budget,
        finite_budgets: _,
        mut destinations,
    } = lane;

    // Source generations can overlap on the durable destination connection:
    // QUIC does not order an old stream's FIN before a new stream's prefix.
    // Stamp the registry's identity once per stream without interpreting the
    // opaque channel byte or adding any per-record work.
    let mut source_prefix = [0u8; 8 + RELIABLE_CHANNEL_PREFIX_BYTES];
    source_prefix[..8].copy_from_slice(&source_attachment_id.as_u64().to_be_bytes());
    source_prefix[8..].copy_from_slice(&channel);

    let mut credit = finite::SourceCredit::new(Arc::clone(&source_connection), &recv, false);
    let mut pending = Bytes::new();
    // One wait on the source's close for the lane's whole life, rather than a
    // state lock and a new registration in every select of every record. Each
    // select returns once it fires, so it is never polled after completing.
    let source_closed = source_connection.closed();
    tokio::pin!(source_closed);
    loop {
        let (destination_id, opened) =
            wait_for_reliable_destination(source_closed.as_mut(), &mut destinations).await?;
        let ReliableOpenedStream {
            mut send,
            connection: destination_connection,
        } = opened;
        let stopped = send.quic_stream().stopped();
        tokio::pin!(stopped);

        let prefix = tokio::select! {
            biased;
            _ = source_closed.as_mut() => return Err(ReliableLaneError::SourceFin),
            changed = destinations.changed() => {
                if changed.is_err() {
                    return Err(ReliableLaneError::DestinationStopped);
                }
                None
            },
            _ = &mut stopped => None,
            result = tokio::time::timeout(
                RELIABLE_OPERATION_TIMEOUT,
                send.write_all(&source_prefix),
            ) => Some(result),
        };
        match prefix {
            Some(Ok(Ok(()))) => {}
            Some(Err(_)) => {
                metrics::record_reliable_write_timeout();
                destination_connection.close(
                    VarInt::from_u32(CLOSE_CODE),
                    b"reliable-destination-prefix-timeout",
                );
                continue;
            }
            Some(Ok(Err(_))) => {
                destination_connection.close(
                    VarInt::from_u32(CLOSE_CODE),
                    b"reliable-destination-prefix-failed",
                );
                continue;
            }
            None => continue,
        }

        // One destination stream serves as many complete records as that
        // attachment survives. A replacement observed between records rotates
        // immediately; a replacement mid-record discards only that record and
        // drains the source to its next framing boundary.
        loop {
            if !destination_is_current(&destinations, destination_id) {
                break;
            }
            // The next record waits at its source until the destination
            // stream has sent everything it holds, so the stream never queues
            // more than one record behind what the congestion window lets
            // leave. Queued any deeper, records would wait where a replacement
            // discards them and a revival drains them ahead of fresher ones;
            // left at the source, each goes to whichever attachment can carry
            // it first. A steady path sends a record before the next arrives,
            // so this waits only while the destination cannot keep up.
            let drained = tokio::select! {
                biased;
                _ = source_closed.as_mut() => return Err(ReliableLaneError::SourceFin),
                changed = destinations.changed() => {
                    if changed.is_err() {
                        return Err(ReliableLaneError::DestinationStopped);
                    }
                    false
                },
                _ = &mut stopped => false,
                () = send.quic_stream().drained() => true,
            };
            if !drained {
                break;
            }

            let first = tokio::select! {
                biased;
                _ = source_closed.as_mut() => return Err(ReliableLaneError::SourceFin),
                changed = destinations.changed() => {
                    if changed.is_err() {
                        return Err(ReliableLaneError::DestinationStopped);
                    }
                    None
                },
                _ = &mut stopped => None,
                result = next_reliable_chunk(&mut recv, &mut pending, RELIABLE_READ_MAX_BYTES) => Some(result),
            };
            let Some(first) = first else {
                break;
            };
            let first = first
                .map_err(|_| ReliableLaneError::HeaderRead)?
                .ok_or(ReliableLaneError::SourceFin)?;

            let deadline = tokio::time::Instant::now() + RELIABLE_OPERATION_TIMEOUT;
            let mut head = tokio::time::timeout_at(
                deadline,
                read_reliable_head(&mut recv, &mut pending, first),
            )
            .await
            .map_err(|_| ReliableLaneError::SourceTimeout)??;
            let body_len = head.body_len();
            let mut remaining = head.remaining();
            // Record budget other lanes hold frees only as their records land.
            let _budget = match ReliableRecordBudget::try_acquire(
                &direction_budget,
                &global_budget,
                body_len,
            ) {
                Some(budget) => budget,
                None => {
                    credit.park(true);
                    let budget = tokio::time::timeout_at(
                        deadline,
                        ReliableRecordBudget::acquire(&direction_budget, &global_budget, body_len),
                    )
                    .await;
                    credit.park(false);
                    budget
                        .map_err(|_| ReliableLaneError::SourceTimeout)?
                        .ok_or(ReliableLaneError::BudgetClosed)?
                }
            };

            let header_written = tokio::select! {
                biased;
                _ = source_closed.as_mut() => return Err(ReliableLaneError::SourceFin),
                changed = destinations.changed() => {
                    if changed.is_err() {
                        return Err(ReliableLaneError::DestinationStopped);
                    }
                    false
                },
                _ = &mut stopped => false,
                result = tokio::time::timeout_at(deadline, finite::write_parking(
                    send.quic_stream_mut(),
                    destination_connection.quic_connection(),
                    head.chunks_mut(),
                    &mut credit,
                )) => reliable_write_landed(
                    result,
                    &destination_connection,
                    RELIABLE_HEADER_WRITE_REASONS,
                ),
            };
            // An abandoned write may have left the source parked.
            credit.park(false);
            if !header_written {
                drop(head);
                drain_reliable_body(&mut recv, &mut pending, remaining, deadline).await?;
                break;
            }
            drop(head);

            let mut destination_failed = false;
            while remaining > 0 {
                // Bound both bytes and entries, and take one receive/send lock
                // per ready batch rather than one per QUIC packet fragment.
                let mut chunks = [const { Bytes::new() }; RELIABLE_READ_MAX_CHUNKS];
                let count = tokio::time::timeout_at(
                    deadline,
                    recv.quic_stream_mut()
                        .read_chunks_bounded(&mut chunks, remaining.min(RELIABLE_READ_MAX_BYTES)),
                )
                .await
                .map_err(|_| ReliableLaneError::SourceTimeout)?
                .map_err(|_| ReliableLaneError::BodyRead)?
                .ok_or(ReliableLaneError::BodyRead)?;
                remaining -= chunks[..count].iter().map(Bytes::len).sum::<usize>();

                let written = tokio::select! {
                    biased;
                    _ = source_closed.as_mut() => return Err(ReliableLaneError::SourceFin),
                    changed = destinations.changed() => {
                        if changed.is_err() {
                            return Err(ReliableLaneError::DestinationStopped);
                        }
                        false
                    },
                    _ = &mut stopped => false,
                    result = tokio::time::timeout_at(deadline, finite::write_parking(
                        send.quic_stream_mut(),
                        destination_connection.quic_connection(),
                        &mut chunks[..count],
                        &mut credit,
                    )) => reliable_write_landed(
                        result,
                        &destination_connection,
                        RELIABLE_BODY_WRITE_REASONS,
                    ),
                };
                credit.park(false);
                if !written {
                    destination_failed = true;
                    break;
                }
            }
            if destination_failed {
                drain_reliable_body(&mut recv, &mut pending, remaining, deadline).await?;
                break;
            }
        }
    }
}

/// Close reasons for a destination write that failed and one that timed out.
const RELIABLE_HEADER_WRITE_REASONS: [&[u8]; 2] = [
    b"reliable-destination-header-failed",
    b"reliable-destination-header-timeout",
];
const RELIABLE_BODY_WRITE_REASONS: [&[u8]; 2] = [
    b"reliable-destination-body-failed",
    b"reliable-destination-body-timeout",
];

/// Whether a bounded destination write landed. One that failed or timed out
/// closes the destination connection with its reason.
fn reliable_write_landed(
    result: Result<Result<(), wtransport::quinn::WriteError>, tokio::time::error::Elapsed>,
    destination_connection: &wtransport::Connection,
    [failed, timed_out]: [&[u8]; 2],
) -> bool {
    let reason = match result {
        Ok(Ok(())) => return true,
        Ok(Err(_)) => failed,
        Err(_) => {
            metrics::record_reliable_write_timeout();
            timed_out
        }
    };
    destination_connection.close(VarInt::from_u32(CLOSE_CODE), reason);
    false
}

fn destination_is_current(
    destinations: &tokio::sync::watch::Receiver<Option<crate::splice::ReliableDestination>>,
    attachment_id: crate::splice::AttachmentId,
) -> bool {
    destinations
        .borrow()
        .as_ref()
        .is_some_and(|destination| destination.attachment_id == attachment_id)
}

async fn wait_for_reliable_destination(
    mut source_closed: std::pin::Pin<&mut impl Future<Output = wtransport::error::ConnectionError>>,
    destinations: &mut tokio::sync::watch::Receiver<Option<crate::splice::ReliableDestination>>,
) -> Result<(crate::splice::AttachmentId, ReliableOpenedStream), ReliableLaneError> {
    let mut rejected = None;
    loop {
        let candidate = destinations.borrow_and_update().clone();
        if let Some(destination) = candidate
            && Some(destination.attachment_id) != rejected
            && let Some(sender) = destination.upgrade()
        {
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            let requested = tokio::select! {
                biased;
                _ = source_closed.as_mut() => return Err(ReliableLaneError::SourceFin),
                changed = destinations.changed() => {
                    if changed.is_err() {
                        return Err(ReliableLaneError::DestinationStopped);
                    }
                    false
                },
                result = sender.send(crate::splice::ReliableOpenRequest {
                    finite: false, reply: reply_tx, waiting: None,
                }) => result.is_ok(),
            };
            if !requested {
                rejected = Some(destination.attachment_id);
                continue;
            }
            let opened = tokio::select! {
                biased;
                _ = source_closed.as_mut() => return Err(ReliableLaneError::SourceFin),
                changed = destinations.changed() => {
                    if changed.is_err() {
                        return Err(ReliableLaneError::DestinationStopped);
                    }
                    None
                },
                result = tokio::time::timeout(RELIABLE_OPERATION_TIMEOUT, reply_rx) => {
                    result.ok().and_then(Result::ok).flatten()
                },
            };
            if let Some(opened) = opened
                && destination_is_current(destinations, destination.attachment_id)
            {
                return Ok((destination.attachment_id, opened));
            }
            rejected = Some(destination.attachment_id);
            continue;
        }

        tokio::select! {
            biased;
            _ = source_closed.as_mut() => return Err(ReliableLaneError::SourceFin),
            changed = destinations.changed() => {
                if changed.is_err() {
                    return Err(ReliableLaneError::DestinationStopped);
                }
            },
        }
    }
}

async fn next_reliable_chunk(
    source: &mut wtransport::RecvStream,
    pending: &mut Bytes,
    limit: usize,
) -> Result<Option<Bytes>, wtransport::quinn::ReadError> {
    if !pending.is_empty() {
        return Ok(Some(pending.split_to(limit.min(pending.len()))));
    }
    Ok(source
        .quic_stream_mut()
        .read_chunk(limit, true)
        .await?
        .map(|chunk| chunk.bytes))
}

async fn read_reliable_head(
    source: &mut wtransport::RecvStream,
    pending: &mut Bytes,
    mut chunk: Bytes,
) -> Result<RecordHead, ReliableLaneError> {
    let mut head = RecordHead::new();
    loop {
        if head.push(&mut chunk)? {
            *pending = chunk;
            return Ok(head);
        }
        chunk = next_reliable_chunk(source, pending, RELIABLE_READ_MAX_BYTES)
            .await
            .map_err(|_| ReliableLaneError::HeaderRead)?
            .ok_or(ReliableLaneError::HeaderRead)?;
    }
}

async fn drain_reliable_body(
    source: &mut wtransport::RecvStream,
    pending: &mut Bytes,
    mut remaining: usize,
    deadline: tokio::time::Instant,
) -> Result<(), ReliableLaneError> {
    while remaining > 0 {
        let chunk = tokio::time::timeout_at(
            deadline,
            next_reliable_chunk(source, pending, remaining.min(RELIABLE_READ_MAX_BYTES)),
        )
        .await
        .map_err(|_| ReliableLaneError::SourceTimeout)?
        .map_err(|_| ReliableLaneError::BodyRead)?
        .ok_or(ReliableLaneError::BodyRead)?;
        remaining -= chunk.len();
    }
    Ok(())
}

#[cfg(test)]
async fn copy_reliable_lane_until_stopped<R, W, F, O>(
    source: &mut R,
    destination: &mut W,
    direction_budget: &Arc<tokio::sync::Semaphore>,
    global_budget: &Arc<tokio::sync::Semaphore>,
    stopped: F,
) -> Result<(), ReliableLaneError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: std::future::Future<Output = O>,
{
    tokio::pin!(stopped);
    tokio::select! {
        biased;
        _ = &mut stopped => Err(ReliableLaneError::DestinationStopped),
        result = copy_reliable_lane(source, destination, direction_budget, global_budget) => result,
    }
}

/// Copy one opaque persistent lane with no per-record allocation. The channel
/// prefix is forwarded verbatim once. Between records a lane may remain idle;
/// after the first header byte arrives, the complete header/body operation is
/// bounded by [`RELIABLE_OPERATION_TIMEOUT`].
#[cfg(test)]
async fn copy_reliable_lane<R, W>(
    source: &mut R,
    destination: &mut W,
    direction_budget: &Arc<tokio::sync::Semaphore>,
    global_budget: &Arc<tokio::sync::Semaphore>,
) -> Result<(), ReliableLaneError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut channel = [0u8; RELIABLE_CHANNEL_PREFIX_BYTES];
    tokio::time::timeout(RELIABLE_OPERATION_TIMEOUT, async {
        source
            .read_exact(&mut channel)
            .await
            .map_err(|_| ReliableLaneError::PrefixRead)?;
        destination
            .write_all(&channel)
            .await
            .map_err(|_| ReliableLaneError::PrefixWrite)
    })
    .await
    .map_err(|_| ReliableLaneError::Timeout)??;

    let mut header = [0u8; RELIABLE_RECORD_HEADER_BYTES];
    let mut buffer = [0u8; RELIABLE_COPY_BUFFER_BYTES];
    loop {
        let read = source
            .read(&mut header[..1])
            .await
            .map_err(|_| ReliableLaneError::HeaderRead)?;
        if read == 0 {
            return Err(ReliableLaneError::SourceFin);
        }

        tokio::time::timeout(RELIABLE_OPERATION_TIMEOUT, async {
            source
                .read_exact(&mut header[1..])
                .await
                .map_err(|_| ReliableLaneError::HeaderRead)?;
            let body_len =
                reliable_body_len_from_header(&header).ok_or(ReliableLaneError::InvalidLength)?;
            let _budget = ReliableRecordBudget::acquire(direction_budget, global_budget, body_len)
                .await
                .ok_or(ReliableLaneError::BudgetClosed)?;

            destination
                .write_all(&header)
                .await
                .map_err(|_| ReliableLaneError::HeaderWrite)?;
            let mut remaining = body_len;
            while remaining > 0 {
                let chunk_len = remaining.min(buffer.len());
                let read = source
                    .read(&mut buffer[..chunk_len])
                    .await
                    .map_err(|_| ReliableLaneError::BodyRead)?;
                if read == 0 {
                    return Err(ReliableLaneError::BodyRead);
                }
                destination
                    .write_all(&buffer[..read])
                    .await
                    .map_err(|_| ReliableLaneError::BodyWrite)?;
                remaining -= read;
            }
            Ok(())
        })
        .await
        .map_err(|_| ReliableLaneError::Timeout)??;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A destructor that panics while the stack is already unwinding is a
    /// non-unwinding panic: without containment the process aborts, and on this
    /// relay that takes every other spliced session with it.
    ///
    /// This is the exact production shape — a first panic, then `SendStream`'s
    /// destructor panicking on quinn's poisoned connection mutex as the frame
    /// unwinds. If containment regresses, this test does not fail; the whole
    /// test binary aborts, which is the point.
    #[test]
    fn a_panicking_stream_drop_during_unwinding_does_not_abort() {
        struct PanicsOnDrop;
        impl Drop for PanicsOnDrop {
            fn drop(&mut self) {
                panic!("poisoned connection mutex");
            }
        }

        let unwound = std::panic::catch_unwind(|| {
            let _contained = ContainedStream::new(PanicsOnDrop);
            panic!("first panic, as some quinn internal would raise");
        });

        // The *first* panic is what escapes. The destructor's panic was
        // contained, so unwinding completed normally instead of aborting.
        let payload = unwound.expect_err("the first panic must still propagate");
        let message = payload
            .downcast_ref::<&'static str>()
            .copied()
            .unwrap_or_default();
        assert!(
            message.starts_with("first panic"),
            "expected the original panic to survive, got {message:?}"
        );
    }

    /// Containment must not change the ordinary path: a healthy stream is still
    /// dropped exactly once.
    #[test]
    fn a_contained_stream_drops_its_inner_value_exactly_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static DROPS: AtomicUsize = AtomicUsize::new(0);
        struct CountsDrops;
        impl Drop for CountsDrops {
            fn drop(&mut self) {
                DROPS.fetch_add(1, Ordering::SeqCst);
            }
        }

        drop(ContainedStream::new(CountsDrops));
        assert_eq!(DROPS.load(Ordering::SeqCst), 1);
    }

    /// The source/destination split is what lets a browser carrier die without
    /// taking the daemon's connection with it. Getting a variant on the wrong
    /// side is silent: either a rebind window collapses immediately, or a
    /// genuinely broken source is left attached until its slot expires.
    #[test]
    fn lane_errors_classify_which_peer_they_implicate() {
        for error in [
            ReliableLaneError::PrefixRead,
            ReliableLaneError::SourceFin,
            ReliableLaneError::HeaderRead,
            ReliableLaneError::InvalidLength,
            ReliableLaneError::BodyRead,
            ReliableLaneError::BudgetClosed,
            ReliableLaneError::SourceTimeout,
        ] {
            assert!(error.implicates_source(), "{error:?} reads from the source");
        }
        for error in [
            ReliableLaneError::DestinationStopped,
            ReliableLaneError::PrefixWrite,
            ReliableLaneError::HeaderWrite,
            ReliableLaneError::BodyWrite,
            ReliableLaneError::Timeout,
        ] {
            assert!(
                !error.implicates_source(),
                "{error:?} is the destination going away, which during a rebind \
                 window is expected rather than a source fault"
            );
        }
    }
    use std::net::{Ipv6Addr, SocketAddr};

    use crate::cert::EdgeCert;
    use crate::splice::{
        MAX_RELIABLE_BODY, PREFACE_VERSION, Role, RoutingPreface, SpliceControlEvent,
    };
    use wtransport::endpoint::endpoint_side::Client;
    use wtransport::tls::Sha256Digest;
    use wtransport::{ClientConfig, RecvStream, SendStream};

    /// The one dataplane process every test daemon attachment comes from.
    pub(super) const TEST_INCARNATION: &str = "AAAAAAAAAAAAAAAAAAAAAA";

    /// The attachment a test peer of `role` joins a splice with.
    pub(super) fn test_attachment(role: Role) -> RoutingAttachment {
        match role {
            Role::Browser => RoutingAttachment::Primary,
            Role::Daemon => RoutingAttachment::Tunnel {
                incarnation: TEST_INCARNATION.to_string(),
            },
        }
    }

    pub(super) async fn attach_test_peer(
        endpoint: &Endpoint<Client>,
        url: &str,
        session_id: &str,
        role: Role,
    ) -> (
        wtransport::Connection,
        SendStream,
        RecvStream,
        Option<(SendStream, RecvStream)>,
    ) {
        let connection = endpoint.connect(url).await.expect("test peer connects");
        let (mut send, recv) = connection
            .open_bi()
            .await
            .expect("open preface stream")
            .await
            .expect("establish preface stream");
        let json = serde_json::to_vec(&RoutingPreface {
            session_id: session_id.to_string(),
            role,
            version: PREFACE_VERSION,
            attachment: test_attachment(role),
            daemon_id: crate::attach_ticket::TEST_DAEMON_ID.to_string(),
            ticket: crate::attach_ticket::test_ticket(role.into(), session_id),
        })
        .expect("serialize preface");
        send.write_all(&(json.len() as u32).to_be_bytes())
            .await
            .expect("write preface length");
        send.write_all(&json).await.expect("write preface body");
        let quote_recv = if role == Role::Daemon {
            let (mut quote_send, quote_recv) = connection
                .open_bi()
                .await
                .expect("open delivery-quote stream")
                .await
                .expect("establish delivery-quote stream");
            quote_send
                .write_all(DELIVERY_QUOTE_STREAM_PREFACE)
                .await
                .expect("write delivery-quote preface");
            Some((quote_send, quote_recv))
        } else {
            None
        };
        (connection, send, recv, quote_recv)
    }

    pub(super) async fn read_test_control(recv: &mut RecvStream) -> SpliceControlEvent {
        let mut header = [0u8; RELIABLE_RECORD_HEADER_BYTES];
        tokio::time::timeout(Duration::from_secs(3), recv.read_exact(&mut header))
            .await
            .expect("splice control length timeout")
            .expect("splice control length");
        let length = u32::from_be_bytes(header) as usize;
        let mut json = vec![0u8; length];
        tokio::time::timeout(Duration::from_secs(3), recv.read_exact(&mut json))
            .await
            .expect("splice control body timeout")
            .expect("splice control body");
        serde_json::from_slice(&json).expect("splice control JSON")
    }

    /// The next lifecycle event. Path reports share the stream and have their
    /// own tests, so they are passed over here.
    pub(super) async fn read_test_lifecycle(recv: &mut RecvStream) -> SpliceControlEvent {
        let mut probing = false;
        loop {
            match read_test_control(recv).await {
                // Exactly one pending observation may precede the fresh proof.
                SpliceControlEvent::CounterpartProbing {
                    counterpart_attachment_id,
                    ..
                } if !probing => {
                    assert_ne!(counterpart_attachment_id, 0);
                    probing = true;
                }
                SpliceControlEvent::ObservedPath { .. }
                | SpliceControlEvent::CounterpartPath { .. } => {}
                event => return event,
            }
        }
    }

    pub(super) async fn read_test_delivery_quote(
        recv: &mut RecvStream,
    ) -> SpliceDeliveryQuoteEvent {
        let mut header = [0u8; RELIABLE_RECORD_HEADER_BYTES];
        tokio::time::timeout(Duration::from_secs(3), recv.read_exact(&mut header))
            .await
            .expect("delivery quote length timeout")
            .expect("delivery quote length");
        let length = u32::from_be_bytes(header) as usize;
        let mut json = vec![0u8; length];
        tokio::time::timeout(Duration::from_secs(3), recv.read_exact(&mut json))
            .await
            .expect("delivery quote body timeout")
            .expect("delivery quote body");
        serde_json::from_slice(&json).expect("delivery quote JSON")
    }

    async fn copy_test_wire(
        wire: Vec<u8>,
        direction_bytes: usize,
        global_bytes: usize,
    ) -> (Result<(), ReliableLaneError>, Vec<u8>) {
        let capacity = wire.len().max(64);
        let (mut source_writer, mut source_reader) = tokio::io::duplex(capacity);
        let (mut destination_writer, mut destination_reader) = tokio::io::duplex(capacity);
        let direction = Arc::new(tokio::sync::Semaphore::new(direction_bytes));
        let global = Arc::new(tokio::sync::Semaphore::new(global_bytes));
        let copy = tokio::spawn(async move {
            copy_reliable_lane(
                &mut source_reader,
                &mut destination_writer,
                &direction,
                &global,
            )
            .await
        });

        source_writer.write_all(&wire).await.expect("source write");
        source_writer.shutdown().await.expect("source finish");
        let result = copy.await.expect("copy task");
        let mut forwarded = Vec::new();
        destination_reader
            .read_to_end(&mut forwarded)
            .await
            .expect("destination read");
        (result, forwarded)
    }

    #[test]
    fn role_constants_are_distinct() {
        // Sanity that the relay uses both roles symmetrically.
        assert_ne!(Role::Browser, Role::Daemon);
    }

    /// A browser hears its proven address once per network: a NAT rebinding
    /// that keeps the address writes nothing, a validated move to another
    /// address writes the new one.
    #[tokio::test(start_paused = true)]
    async fn a_path_report_is_written_once_per_address() {
        use wtransport::quinn::ValidatedPath;
        let path = |sequence, remote: &str| ValidatedPath {
            sequence,
            remote: remote.parse().expect("socket address"),
        };
        let (sender, receiver) = tokio::sync::watch::channel(Some(path(1, "203.0.113.9:4000")));
        let mut paths = PathReports::Own(receiver);
        let initial = paths.next(None).await;
        assert_eq!(
            initial,
            SpliceControlEvent::ObservedPath {
                address: "203.0.113.9".parse().expect("address"),
            }
        );

        sender.send_replace(Some(path(2, "203.0.113.9:4001")));
        assert!(
            tokio::time::timeout(Duration::from_secs(1), paths.next(Some(initial)))
                .await
                .is_err(),
            "a port-only rebinding is the same network"
        );

        sender.send_replace(Some(path(3, "[::ffff:198.51.100.4]:5000")));
        assert_eq!(
            paths.next(Some(initial)).await,
            SpliceControlEvent::ObservedPath {
                address: "198.51.100.4".parse().expect("address"),
            }
        );
    }

    #[tokio::test]
    async fn retirement_writer_waits_for_the_owners_specific_close_without_sending_fin() {
        use std::future::{Future, poll_fn};
        use std::task::Poll;

        tokio::time::timeout(Duration::from_secs(5), async {
            let cert = EdgeCert::generate(&["localhost"]).expect("certificate");
            let cert_hash = cert.cert_hash;
            let server = build_server(
                &cert,
                "127.0.0.1:0".parse().expect("address"),
                &EndpointSecret::generate().expect("secret"),
            )
            .expect("server");
            let url = format!(
                "https://127.0.0.1:{}",
                server.local_addr().expect("address").port()
            );
            let client = Endpoint::client(
                ClientConfig::builder()
                    .with_bind_default()
                    .with_server_certificate_hashes([Sha256Digest::new(cert_hash)])
                    .build(),
            )
            .expect("client");
            let accepted = async {
                server
                    .accept()
                    .await
                    .await
                    .expect("request")
                    .accept()
                    .await
                    .expect("accept")
            };
            let (edge, peer) = tokio::join!(accepted, client.connect(&url));
            let peer = peer.expect("connect");
            let mut send = edge
                .open_uni()
                .await
                .expect("open")
                .await
                .expect("establish");
            send.write_all(&[0x71]).await.expect("announce stream");
            let mut recv = peer.accept_uni().await.expect("accept stream");
            let mut byte = [0u8; 1];
            recv.read_exact(&mut byte).await.expect("read announcement");
            let (sender, lifecycle) = tokio::sync::watch::channel(None);
            let mut owner_lifecycle = lifecycle.clone();
            let mut writer = std::pin::pin!(write_splice_lifecycle_controls(
                ContainedStream::new(send),
                lifecycle,
                &edge,
                tokio::sync::watch::channel(None).1,
                tokio::sync::watch::channel(None).1,
                None,
                PathReports::None,
            ));

            sender
                .send(Some(AttachmentLifecycle::Retire(
                    RetireReason::RebindWindowExpired,
                )))
                .expect("retire");
            drop(sender);
            // Deterministically let the writer consume Retire AND observe the
            // sender's closure before the owner polls its own watch receiver.
            poll_fn(|context| {
                assert!(
                    writer.as_mut().poll(context).is_pending(),
                    "Retire must not finish/error the writer before owner close"
                );
                Poll::Ready(())
            })
            .await;
            assert!(
                tokio::time::timeout(Duration::from_millis(10), recv.read(&mut byte))
                    .await
                    .is_err(),
                "Retire must not drop the stream and expose an early FIN"
            );
            assert!(matches!(
                next_attachment_lifecycle(&mut owner_lifecycle).await,
                Some(AttachmentLifecycle::Retire(
                    RetireReason::RebindWindowExpired
                ))
            ));
            edge.close(
                VarInt::from_u32(COUNTERPART_DETACHED_CLOSE_CODE),
                COUNTERPART_DETACHED_CLOSE_REASON,
            );
            writer.await.expect("normal retirement completion");
            match peer.closed().await {
                wtransport::error::ConnectionError::ApplicationClosed(close) => {
                    assert_eq!(
                        close.code(),
                        VarInt::from_u32(COUNTERPART_DETACHED_CLOSE_CODE)
                    );
                    assert_eq!(close.reason(), COUNTERPART_DETACHED_CLOSE_REASON);
                }
                error => panic!("unexpected retirement: {error:?}"),
            }
        })
        .await
        .expect("bounded retirement test");
    }

    fn residence_total(quote: &SpliceDeliveryQuoteEvent) -> u32 {
        let SpliceDeliveryQuoteEvent::CounterpartDeliveryQuote {
            forward_residence, ..
        } = quote;
        forward_residence.iter().sum()
    }

    /// Contention evidence is off unless the session's daemon asks for it on
    /// its quote stream: until then a relayed datagram reads no clock and the
    /// quote carries none, and withdrawing the request zeroes it again.
    #[tokio::test]
    async fn relay_residence_is_timed_only_while_the_daemon_asks() {
        let cert = EdgeCert::generate(&["localhost"]).expect("test edge certificate");
        let server = Arc::new(
            build_server(
                &cert,
                "127.0.0.1:0".parse().expect("bind address"),
                &EndpointSecret::generate().expect("secret"),
            )
            .expect("test edge server"),
        );
        let port = server.local_addr().expect("server address").port();
        let accept_task = tokio::spawn(accept_loop(
            server,
            SpliceRegistry::new(),
            crate::attach_ticket::test_key(),
            crate::egress_budget::test_open_budget(),
        ));
        let client = Endpoint::client(
            ClientConfig::builder()
                .with_bind_default()
                .with_server_certificate_hashes([Sha256Digest::new(cert.cert_hash)])
                .build(),
        )
        .expect("test client endpoint");
        let url = format!("https://127.0.0.1:{port}");
        let session_id = "contention-requests";
        let (daemon, _daemon_preface_send, mut daemon_control, daemon_quote) =
            attach_test_peer(&client, &url, session_id, Role::Daemon).await;
        let (mut requests, mut quotes) = daemon_quote.expect("daemon delivery-quote stream");
        read_test_lifecycle(&mut daemon_control).await;
        let (browser, _browser_preface_send, mut browser_control, _) =
            attach_test_peer(&client, &url, session_id, Role::Browser).await;
        read_test_lifecycle(&mut browser_control).await;
        read_test_lifecycle(&mut browser_control).await;
        let mut probe = daemon.accept_uni().await.expect("transport probe");
        assert_eq!(probe.read(&mut [0u8; 1]).await.expect("probe FIN"), None);
        read_test_lifecycle(&mut daemon_control).await;
        assert_eq!(
            residence_total(&read_test_delivery_quote(&mut quotes).await),
            0
        );

        let relay = |count: usize| {
            let (daemon, browser) = (&daemon, &browser);
            async move {
                for _ in 0..count {
                    daemon
                        .send_datagram(b"opaque-echo")
                        .expect("daemon datagram");
                    let received =
                        tokio::time::timeout(Duration::from_secs(3), browser.receive_datagram())
                            .await
                            .expect("relayed datagram timeout")
                            .expect("relayed datagram");
                    assert_eq!(received.payload().as_ref(), b"opaque-echo");
                }
            }
        };
        // Nobody asked: fifty datagrams cross untimed.
        relay(50).await;
        requests.write_all(&[1]).await.expect("request contention");
        relay(20).await;
        // The first quote with residence counts only datagrams relayed after
        // the request, never the fifty before it.
        let timed = loop {
            let total = residence_total(&read_test_delivery_quote(&mut quotes).await);
            if total != 0 {
                break total;
            }
        };
        assert!(
            timed <= 20,
            "{timed} datagrams timed; at most the 20 after the request"
        );
        // Withdrawn, the next quote carries none.
        requests.write_all(&[0]).await.expect("withdraw contention");
        relay(1).await;
        while residence_total(&read_test_delivery_quote(&mut quotes).await) != 0 {}
        accept_task.abort();
    }

    /// The open-relay regression: a preface whose ticket the edge's key did not
    /// sign is closed before it reaches the registry.
    #[tokio::test]
    async fn a_forged_ticket_is_closed_before_the_registry() {
        let cert = EdgeCert::generate(&["localhost"]).expect("test edge certificate");
        let cert_hash = cert.cert_hash;
        let server = Arc::new(
            build_server(
                &cert,
                "127.0.0.1:0".parse().expect("bind address"),
                &EndpointSecret::generate().expect("secret"),
            )
            .expect("test edge server"),
        );
        let port = server.local_addr().expect("server address").port();
        let accept_task = tokio::spawn(accept_loop(
            server,
            SpliceRegistry::new(),
            crate::attach_ticket::test_key(),
            crate::egress_budget::test_open_budget(),
        ));
        let client = Endpoint::client(
            ClientConfig::builder()
                .with_bind_default()
                .with_server_certificate_hashes([Sha256Digest::new(cert_hash)])
                .build(),
        )
        .expect("test client endpoint");
        let connection = client
            .connect(format!("https://127.0.0.1:{port}"))
            .await
            .expect("peer connects");
        let (mut send, _recv) = connection
            .open_bi()
            .await
            .expect("open preface stream")
            .await
            .expect("establish preface stream");
        let forged =
            crate::attach_ticket::AttachTicketKey::new(&[1u8; crate::attach_ticket::KEY_LEN])
                .issue(
                    crate::attach_ticket::TicketRole::Browser,
                    crate::attach_ticket::TEST_DAEMON_ID,
                    "forged",
                    0,
                )
                .expect("forged ticket");
        let json = serde_json::to_vec(&RoutingPreface {
            session_id: "forged".to_string(),
            role: Role::Browser,
            version: PREFACE_VERSION,
            attachment: RoutingAttachment::Primary,
            daemon_id: crate::attach_ticket::TEST_DAEMON_ID.to_string(),
            ticket: forged,
        })
        .expect("serialize preface");
        send.write_all(&(json.len() as u32).to_be_bytes())
            .await
            .expect("write preface length");
        send.write_all(&json).await.expect("write preface body");
        let closed = tokio::time::timeout(Duration::from_secs(3), connection.closed())
            .await
            .expect("the edge closes a forged attachment");
        match closed {
            wtransport::error::ConnectionError::ApplicationClosed(close) => {
                assert_eq!(close.reason(), b"bad-ticket")
            }
            other => panic!("closed for another reason: {other:?}"),
        }
        accept_task.abort();
    }

    /// Production-shape regression for the incident: the browser's QUIC
    /// CONNECTION_CLOSE is delivered to a real edge endpoint while a daemon
    /// reliable source lane is active. The daemon transport and source stream
    /// must survive, an interrupted record must be discarded to its framing
    /// boundary, and the next complete record must arrive on the replacement
    /// browser attachment.
    #[tokio::test]
    async fn delivered_browser_close_rotates_only_the_reliable_destination() {
        let cert = EdgeCert::generate(&["localhost"]).expect("test edge certificate");
        let cert_hash = cert.cert_hash;
        let server = Arc::new(
            build_server(
                &cert,
                "127.0.0.1:0".parse().expect("bind address"),
                &EndpointSecret::generate().expect("secret"),
            )
            .expect("test edge server"),
        );
        let port = server.local_addr().expect("server address").port();
        let registry = SpliceRegistry::new();
        let accept_task = tokio::spawn(accept_loop(
            server,
            registry,
            crate::attach_ticket::test_key(),
            crate::egress_budget::test_open_budget(),
        ));

        let client = Endpoint::client(
            ClientConfig::builder()
                .with_bind_default()
                .with_server_certificate_hashes([Sha256Digest::new(cert_hash)])
                .build(),
        )
        .expect("test client endpoint");
        let url = format!("https://127.0.0.1:{port}");
        let session_id = "delivered-close-source-owned-lane";

        let (daemon, _daemon_preface_send, mut daemon_control, daemon_quote) =
            attach_test_peer(&client, &url, session_id, Role::Daemon).await;
        let (_daemon_quote_send, mut daemon_quote) =
            daemon_quote.expect("daemon delivery-quote stream");
        assert_eq!(
            read_test_lifecycle(&mut daemon_control).await,
            SpliceControlEvent::CounterpartPresent {
                present: false,
                counterpart_attachment_id: None,
            }
        );
        let (browser, _browser_preface_send, mut browser_control, browser_quote) =
            attach_test_peer(&client, &url, session_id, Role::Browser).await;
        assert!(browser_quote.is_none());
        let daemon_attachment_id = match read_test_lifecycle(&mut browser_control).await {
            SpliceControlEvent::CounterpartPresent {
                present: true,
                counterpart_attachment_id: Some(id),
            } => id,
            other => panic!("expected daemon presence, got {other:?}"),
        };
        assert_eq!(
            read_test_lifecycle(&mut browser_control).await,
            SpliceControlEvent::CounterpartResponsive {
                counterpart_attachment_id: daemon_attachment_id,
            }
        );
        // QUIC acknowledges the empty stream independently of application reads.
        // The probe introduces neither a channel prefix nor an opaque payload.
        let mut probe = daemon.accept_uni().await.expect("transport probe");
        assert_eq!(probe.read(&mut [0u8; 1]).await.expect("probe FIN"), None);
        assert!(matches!(
            read_test_lifecycle(&mut daemon_control).await,
            SpliceControlEvent::CounterpartAttached {
                counterpart_attachment_id: _
            }
        ));
        assert!(matches!(
            read_test_delivery_quote(&mut daemon_quote).await,
            SpliceDeliveryQuoteEvent::CounterpartDeliveryQuote { .. }
        ));

        let mut daemon_lane = daemon
            .open_uni()
            .await
            .expect("open daemon source lane")
            .await
            .expect("establish daemon source lane");
        daemon_lane
            .write_all(&[0x7a])
            .await
            .expect("write logical channel prefix");
        let first = b"before-close";
        daemon_lane
            .write_all(&(first.len() as u32).to_be_bytes())
            .await
            .expect("write first header");
        daemon_lane
            .write_all(first)
            .await
            .expect("write first body");

        let mut browser_lane = tokio::time::timeout(Duration::from_secs(3), browser.accept_uni())
            .await
            .expect("browser lane timeout")
            .expect("browser accepts lane");
        let mut channel = [0u8; 9];
        browser_lane
            .read_exact(&mut channel)
            .await
            .expect("browser reads channel");
        assert_eq!(channel[8], 0x7a);
        assert_eq!(
            u64::from_be_bytes(channel[..8].try_into().unwrap()),
            daemon_attachment_id
        );
        let mut header = [0u8; RELIABLE_RECORD_HEADER_BYTES];
        browser_lane
            .read_exact(&mut header)
            .await
            .expect("browser reads first header");
        assert_eq!(u32::from_be_bytes(header) as usize, first.len());
        let mut first_body = vec![0u8; first.len()];
        browser_lane
            .read_exact(&mut first_body)
            .await
            .expect("browser reads first body");
        assert_eq!(first_body, first);

        // Eight MiB is larger than the destination stream window. Reading one
        // byte proves the actor entered this record; closing now deterministically
        // makes it rotate mid-record rather than between records.
        let interrupted_len = MAX_RELIABLE_BODY;
        let interrupted = vec![0x6bu8; interrupted_len];
        let writer = tokio::spawn(async move {
            daemon_lane
                .write_all(&(interrupted_len as u32).to_be_bytes())
                .await
                .expect("write interrupted header");
            daemon_lane
                .write_all(&interrupted)
                .await
                .expect("source remains writable while edge drains record");
            daemon_lane
        });
        browser_lane
            .read_exact(&mut header)
            .await
            .expect("browser reads interrupted header");
        assert_eq!(u32::from_be_bytes(header) as usize, interrupted_len);
        let mut entered_body = [0u8; 1];
        browser_lane
            .read_exact(&mut entered_body)
            .await
            .expect("browser enters interrupted body");
        assert_eq!(entered_body, [0x6b]);

        // This is an actual QUIC close delivered through the endpoint, not the
        // UDP blackhole used by the broad reconnect scenario.
        browser.close(VarInt::from_u32(41), b"delivered-browser-close");
        assert!(matches!(
            read_test_lifecycle(&mut daemon_control).await,
            SpliceControlEvent::CounterpartDetached { .. }
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), daemon.closed())
                .await
                .is_err(),
            "destination loss must not close the daemon source connection"
        );
        let mut daemon_lane = tokio::time::timeout(Duration::from_secs(3), writer)
            .await
            .expect("source drain timeout")
            .expect("source writer task");

        let (replacement, _replacement_preface_send, mut replacement_control, replacement_quote) =
            attach_test_peer(&client, &url, session_id, Role::Browser).await;
        assert!(replacement_quote.is_none());
        assert!(matches!(
            read_test_lifecycle(&mut replacement_control).await,
            SpliceControlEvent::CounterpartPresent {
                present: true,
                counterpart_attachment_id: Some(_),
            }
        ));
        assert!(matches!(
            read_test_lifecycle(&mut daemon_control).await,
            SpliceControlEvent::CounterpartAttached {
                counterpart_attachment_id: _
            }
        ));
        assert_eq!(
            read_test_lifecycle(&mut replacement_control).await,
            SpliceControlEvent::CounterpartResponsive {
                counterpart_attachment_id: daemon_attachment_id,
            }
        );
        let mut fresh_probe = daemon.accept_uni().await.expect("fresh transport probe");
        assert_ne!(fresh_probe.id(), probe.id());
        assert_eq!(
            fresh_probe
                .read(&mut [0u8; 1])
                .await
                .expect("fresh probe FIN"),
            None
        );

        let mut replacement_lane =
            tokio::time::timeout(Duration::from_secs(3), replacement.accept_uni())
                .await
                .expect("replacement lane timeout")
                .expect("replacement accepts lane");
        replacement_lane
            .read_exact(&mut channel)
            .await
            .expect("replacement reads channel");
        assert_eq!(channel[8], 0x7a);
        assert_eq!(
            u64::from_be_bytes(channel[..8].try_into().unwrap()),
            daemon_attachment_id
        );

        let after = b"after-delivered-close";
        daemon_lane
            .write_all(&(after.len() as u32).to_be_bytes())
            .await
            .expect("write replacement header");
        daemon_lane
            .write_all(after)
            .await
            .expect("write replacement body");
        replacement_lane
            .read_exact(&mut header)
            .await
            .expect("replacement reads header");
        assert_eq!(u32::from_be_bytes(header) as usize, after.len());
        let mut after_body = vec![0u8; after.len()];
        replacement_lane
            .read_exact(&mut after_body)
            .await
            .expect("replacement reads body");
        assert_eq!(after_body, after);

        replacement.close(VarInt::from_u32(0), b"test-complete");
        daemon.close(VarInt::from_u32(0), b"test-complete");
        accept_task.abort();
    }

    #[tokio::test]
    // The edge does not group these slots. Exercise actual QUIC cleanup with
    // all three present, including delayed old-browser close after replacement.
    async fn three_source_connections_survive_independent_browser_replacements() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let cert = EdgeCert::generate(&["localhost"]).expect("certificate");
            let server = Arc::new(
                build_server(
                    &cert,
                    "127.0.0.1:0".parse().unwrap(),
                    &EndpointSecret::generate().unwrap(),
                )
                .unwrap(),
            );
            let url = format!("https://127.0.0.1:{}", server.local_addr().unwrap().port());
            let registry = SpliceRegistry::new();
            let accept_task = tokio::spawn(accept_loop(
                server,
                registry,
                crate::attach_ticket::test_key(),
                crate::egress_budget::test_open_budget(),
            ));
            let client = Endpoint::client(
                ClientConfig::builder()
                    .with_bind_default()
                    .with_server_certificate_hashes([Sha256Digest::new(cert.cert_hash)])
                    .build(),
            )
            .unwrap();
            let labels = ["three#signaling", "three", "three#bulk"];
            let mut sources = Vec::new();
            let mut browsers = Vec::new();
            let mut lanes = Vec::new();
            for label in labels {
                let mut source = attach_test_peer(&client, &url, label, Role::Daemon).await;
                read_test_lifecycle(&mut source.2).await;
                let browser = attach_test_peer(&client, &url, label, Role::Browser).await;
                assert!(matches!(
                    read_test_lifecycle(&mut source.2).await,
                    SpliceControlEvent::CounterpartAttached { .. }
                ));
                let mut lane = source.0.open_uni().await.unwrap().await.unwrap();
                lane.write_all(&[0x25]).await.unwrap();
                sources.push(source);
                browsers.push(browser);
                lanes.push(lane);
            }
            // Data first, signaling last. Neither close may retire the
            // durable daemon source or either other slot's live writer.
            {
                let replaced = 2;
                let replacement =
                    attach_test_peer(&client, &url, labels[replaced], Role::Browser).await;
                let old = std::mem::replace(&mut browsers[replaced], replacement);
                // The routing preface write does not acknowledge attachment.
                // Fence the replacement before testing the old peer's late close.
                assert!(matches!(
                    read_test_lifecycle(&mut sources[replaced].2).await,
                    SpliceControlEvent::CounterpartAttached { .. }
                ));
                old.0.close(VarInt::from_u32(41), b"late-old-browser-close");
                // Each source keeps the SAME reliable stream across all
                // replacements. A response stays routable on signaling.
                for (index, lane) in lanes.iter_mut().enumerate() {
                    lane.write_all(&1u32.to_be_bytes()).await.unwrap();
                    lane.write_all(&[index as u8]).await.unwrap();
                }
                // Retain receive streams below: dropping one is STOP_SENDING,
                // which would test an intentional stream failure instead.
                let mut received = Vec::new();
                for (index, browser) in browsers.iter().enumerate() {
                    let mut stream = browser.0.accept_uni().await.unwrap();
                    let mut record = [0; 14];
                    stream.read_exact(&mut record).await.unwrap();
                    assert_eq!(&record[8..], &[0x25, 0, 0, 0, 1, index as u8]);
                    received.push(stream);
                }
                // Keep unaffected streams and read their next records instead
                // of opening duplicates when another slot is replaced.
                for next in [1, 0] {
                    let replacement =
                        attach_test_peer(&client, &url, labels[next], Role::Browser).await;
                    let old = std::mem::replace(&mut browsers[next], replacement);
                    assert!(matches!(
                        read_test_lifecycle(&mut sources[next].2).await,
                        SpliceControlEvent::CounterpartAttached { .. }
                    ));
                    old.0.close(VarInt::from_u32(41), b"late-old-browser-close");
                    for index in 0..3 {
                        lanes[index].write_all(&1u32.to_be_bytes()).await.unwrap();
                        lanes[index].write_all(&[index as u8]).await.unwrap();
                        if index == next {
                            received[index] = browsers[index].0.accept_uni().await.unwrap();
                            let mut prefix = [0; 9];
                            received[index].read_exact(&mut prefix).await.unwrap();
                            assert_eq!(prefix[8], 0x25);
                        }
                        let mut record = [0; 5];
                        received[index].read_exact(&mut record).await.unwrap();
                        assert_eq!(record, [0, 0, 0, 1, index as u8]);
                    }
                }
            }
            for source in sources {
                source.0.close(VarInt::from_u32(0), b"done");
            }
            for browser in browsers {
                browser.0.close(VarInt::from_u32(0), b"done");
            }
            accept_task.abort();
        })
        .await
        .expect("triple-splice replacement must remain live");
    }

    #[test]
    fn advertised_uni_stream_credit_includes_http3_control_overhead() {
        assert_eq!(HTTP3_CONTROL_UNI_STREAMS, 3);
        assert_eq!(
            MAX_PEER_UNI_STREAMS,
            MAX_RELIABLE_LANES_PER_PEER + MAX_FINITE_STREAMS_PER_PEER + 3
        );
    }

    #[test]
    fn routing_preface_rejects_empty_sessions_and_unknown_versions() {
        assert!(
            validate_routing_preface(RoutingPreface {
                session_id: String::new(),
                role: Role::Browser,
                attachment: RoutingAttachment::Primary,
                version: PREFACE_VERSION,
                daemon_id: String::new(),
                ticket: String::new(),
            })
            .is_err()
        );
        assert!(
            validate_routing_preface(RoutingPreface {
                session_id: "session".to_string(),
                role: Role::Browser,
                attachment: RoutingAttachment::Primary,
                version: PREFACE_VERSION + 1,
                daemon_id: String::new(),
                ticket: String::new(),
            })
            .is_err()
        );
    }

    #[tokio::test]
    async fn persistent_lane_copies_opaque_prefix_and_multiple_records_verbatim() {
        let mut wire = vec![0xA5];
        wire.extend_from_slice(&3u32.to_be_bytes());
        wire.extend_from_slice(b"one");
        wire.extend_from_slice(&0u32.to_be_bytes());
        wire.extend_from_slice(&((RELIABLE_COPY_BUFFER_BYTES + 7) as u32).to_be_bytes());
        wire.extend((0..RELIABLE_COPY_BUFFER_BYTES + 7).map(|index| index as u8));

        let (result, forwarded) = copy_test_wire(
            wire.clone(),
            wire.len() + RELIABLE_RECORD_HEADER_BYTES,
            wire.len() + RELIABLE_RECORD_HEADER_BYTES,
        )
        .await;

        assert_eq!(result, Err(ReliableLaneError::SourceFin));
        assert_eq!(forwarded, wire);
    }

    #[tokio::test]
    async fn oversized_record_ends_lane_before_forwarding_its_header() {
        let mut wire = vec![0x7F];
        wire.extend_from_slice(&((MAX_RELIABLE_BODY + 1) as u32).to_be_bytes());

        let (result, forwarded) = copy_test_wire(wire, 16, 16).await;

        assert_eq!(result, Err(ReliableLaneError::InvalidLength));
        assert_eq!(forwarded, vec![0x7F]);
    }

    #[tokio::test]
    async fn truncated_record_body_ends_lane_and_releases_budgets() {
        let mut wire = vec![0x33];
        wire.extend_from_slice(&5u32.to_be_bytes());
        wire.extend_from_slice(b"abc");
        let direction = Arc::new(tokio::sync::Semaphore::new(9));
        let global = Arc::new(tokio::sync::Semaphore::new(9));
        let (mut source_writer, mut source_reader) = tokio::io::duplex(64);
        let (mut destination_writer, mut destination_reader) = tokio::io::duplex(64);
        let copy_direction = direction.clone();
        let copy_global = global.clone();
        let copy = tokio::spawn(async move {
            copy_reliable_lane(
                &mut source_reader,
                &mut destination_writer,
                &copy_direction,
                &copy_global,
            )
            .await
        });
        source_writer.write_all(&wire).await.expect("source write");
        source_writer.shutdown().await.expect("source finish");

        assert_eq!(
            copy.await.expect("copy task"),
            Err(ReliableLaneError::BodyRead)
        );
        let mut forwarded = Vec::new();
        destination_reader
            .read_to_end(&mut forwarded)
            .await
            .expect("destination read");
        assert_eq!(forwarded, wire);
        assert_eq!(direction.available_permits(), 9);
        assert_eq!(global.available_permits(), 9);
    }

    #[tokio::test]
    async fn truncated_record_header_ends_lane_without_forwarding_partial_header() {
        let wire = vec![0x44, 0, 0];
        let (result, forwarded) = copy_test_wire(wire, 16, 16).await;

        assert_eq!(result, Err(ReliableLaneError::HeaderRead));
        assert_eq!(forwarded, vec![0x44]);
    }

    #[tokio::test]
    async fn idle_destination_stop_ends_the_persistent_lane() {
        let (mut source_writer, mut source_reader) = tokio::io::duplex(64);
        let (mut destination_writer, mut destination_reader) = tokio::io::duplex(64);
        let direction = Arc::new(tokio::sync::Semaphore::new(16));
        let global = Arc::new(tokio::sync::Semaphore::new(16));
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let copy = tokio::spawn(async move {
            copy_reliable_lane_until_stopped(
                &mut source_reader,
                &mut destination_writer,
                &direction,
                &global,
                async move {
                    let _ = stop_rx.await;
                },
            )
            .await
        });

        source_writer
            .write_all(&[0x02])
            .await
            .expect("source channel prefix");
        let mut forwarded_prefix = [0u8; 1];
        destination_reader
            .read_exact(&mut forwarded_prefix)
            .await
            .expect("destination channel prefix");
        assert_eq!(forwarded_prefix, [0x02]);
        stop_tx.send(()).expect("stop observer still alive");

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), copy)
                .await
                .expect("idle destination stop did not wake lane")
                .expect("lane task"),
            Err(ReliableLaneError::DestinationStopped)
        );
    }

    #[tokio::test]
    async fn stuck_pump_teardown_cancels_nested_permit_owner() {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .expect("child permit");
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let mut pump = tokio::spawn(async move {
            let mut children = tokio::task::JoinSet::new();
            children.spawn(async move {
                let _permit = permit;
                let _ = started_tx.send(());
                std::future::pending::<()>().await;
            });
            std::future::pending::<()>().await;
        });
        started_rx.await.expect("nested permit owner started");
        assert_eq!(semaphore.available_permits(), 0);

        settle_session_pump(&mut pump, false, Duration::from_millis(10), "test").await;
        let recovered =
            tokio::time::timeout(Duration::from_secs(1), semaphore.clone().acquire_owned())
                .await
                .expect("nested cancellation did not release its permit")
                .expect("semaphore remained open");
        drop(recovered);
        assert_eq!(semaphore.available_permits(), 1);
    }

    #[tokio::test]
    async fn endpoint_certificate_can_hot_reload_without_rebinding() {
        let bind_addr = SocketAddr::from((Ipv6Addr::LOCALHOST, 0));
        let old = EdgeCert::generate(&["localhost"]).expect("old certificate");
        let new = EdgeCert::generate(&["localhost"]).expect("new certificate");
        let endpoint = build_server(
            &old,
            bind_addr,
            &EndpointSecret::generate().expect("secret"),
        )
        .expect("server endpoint");

        endpoint
            .reload_config(build_server_config(&new, bind_addr), false)
            .expect("hot reload certificate");
    }
}

#[cfg(test)]
#[path = "relay_budget_tests.rs"]
mod budget_tests;
