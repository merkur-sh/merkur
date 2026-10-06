//! Edge registration, health heartbeat, and certificate rotation.
//!
//! Every publication names the certificate the endpoint serves and the one it
//! will serve next (`cert.rs`), and the server hands both to every peer it
//! issues, renews or leases to. A rotation hot-reloads the endpoint with that
//! published next certificate, so a peer that learned the pair at any time
//! since the last rotation dials across it, then publishes the new pair at
//! once. Existing QUIC connections survive `Endpoint::reload_config`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use opentelemetry::trace::{TraceContextExt, TraceFlags};
use ring::rand::{SecureRandom, SystemRandom};
use ring::{digest, hmac};
use serde::Serialize;
use tracing::{error, info, warn};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use wtransport::Endpoint;
use wtransport::endpoint::endpoint_side::Server;

use crate::cert::EdgeCerts;
use crate::metrics;
use crate::relay;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const REGISTRATION_BACKOFF_INITIAL_CEILING_MS: u64 = 250;
const REGISTRATION_BACKOFF_MAX_CEILING_MS: u64 = 5_000;
const REGISTRATION_AUTH_DOMAIN: &[u8] = b"merkur-edge-registration-auth";
const REGISTRATION_METHOD: &[u8] = b"POST";
const REGISTRATION_PATH: &[u8] = b"/api/edge/register";
const REGISTRATION_KEY_BYTES: usize = 64;
const REGISTRATION_NONCE_BYTES: usize = 32;
const EDGE_ID_HEADER: &str = "x-merkur-edge-id";
const EDGE_TIMESTAMP_HEADER: &str = "x-merkur-edge-timestamp";
const EDGE_NONCE_HEADER: &str = "x-merkur-edge-nonce";
const EDGE_AUTH_HEADER: &str = "x-merkur-edge-auth";
static REGISTRATION_BACKOFF_FALLBACK_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Exponential fallback with full jitter. Initial publication remains an
/// immediate event-driven attempt; this schedule is used only after failure.
#[derive(Debug)]
struct RegistrationBackoff {
    ceiling_ms: u64,
}

impl RegistrationBackoff {
    fn new() -> Self {
        Self {
            ceiling_ms: REGISTRATION_BACKOFF_INITIAL_CEILING_MS,
        }
    }

    fn next_delay(&mut self) -> Duration {
        self.next_delay_from_sample(system_jitter_sample(
            &REGISTRATION_BACKOFF_FALLBACK_SEQUENCE,
        ))
    }

    /// Deterministic injection seam for validating the complete jitter range.
    fn next_delay_from_sample(&mut self, sample: u64) -> Duration {
        // Retain sub-millisecond entropy here; the runtime may then honor or
        // coalesce it according to the host timer's actual resolution.
        let ceiling_ns = self.ceiling_ms * 1_000_000;
        let range = ceiling_ns + 1;
        let delay_ns = ((u128::from(sample) * u128::from(range)) >> 64) as u64;
        self.ceiling_ms = self
            .ceiling_ms
            .saturating_mul(2)
            .min(REGISTRATION_BACKOFF_MAX_CEILING_MS);
        Duration::from_nanos(delay_ns)
    }
}

/// Entropy failure cannot be allowed to turn a control-plane outage into an
/// edge-process crash. This fallback keeps fleet instances dispersed using
/// process-local state, wall-clock entropy, and ASLR.
fn system_jitter_sample(fallback_sequence: &AtomicU64) -> u64 {
    let mut bytes = [0_u8; size_of::<u64>()];
    if SystemRandom::new().fill(&mut bytes).is_ok() {
        return u64::from_ne_bytes(bytes);
    }

    let sequence =
        fallback_sequence.fetch_add(0x9e37_79b9_7f4a_7c15, std::sync::atomic::Ordering::Relaxed);
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut value = (elapsed as u64)
        ^ ((elapsed >> 64) as u64)
        ^ sequence
        ^ (std::process::id() as u64).rotate_left(32)
        ^ (fallback_sequence as *const AtomicU64 as usize as u64);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

pub struct EdgePublisher {
    client: reqwest::Client,
    register_url: String,
    registration_key: hmac::Key,
    edge_id: String,
    edge_region: String,
    edge_wt_url: String,
}

#[derive(Debug)]
enum RegistrationPublishError {
    Retryable(String),
    Permanent(String),
}

impl std::fmt::Display for RegistrationPublishError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Retryable(message) | Self::Permanent(message) => formatter.write_str(message),
        }
    }
}

#[derive(Serialize)]
struct RegisterBody<'a> {
    #[serde(rename = "edgeId")]
    edge_id: &'a str,
    #[serde(rename = "edgeRegion")]
    edge_region: &'a str,
    #[serde(rename = "edgeWtUrl")]
    edge_wt_url: &'a str,
    #[serde(rename = "certHash")]
    cert_hash: &'a str,
    #[serde(rename = "certHashes")]
    cert_hashes: &'a [String],
}

impl EdgePublisher {
    pub fn new(
        register_url: String,
        encoded_registration_key: String,
        edge_id: String,
        edge_region: String,
        edge_wt_url: String,
    ) -> Result<Self, String> {
        let parsed_register_url = reqwest::Url::parse(&register_url)
            .map_err(|error| format!("invalid registration URL: {error}"))?;
        let register_is_https = parsed_register_url.scheme() == "https";
        let register_is_loopback_http = parsed_register_url.scheme() == "http"
            && parsed_register_url.host_str().is_some_and(|host| {
                host == "localhost"
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
        if (!register_is_https && !register_is_loopback_http)
            || !parsed_register_url.username().is_empty()
            || parsed_register_url.password().is_some()
            || parsed_register_url.query().is_some()
            || parsed_register_url.fragment().is_some()
            || parsed_register_url.path() != "/api/edge/register"
        {
            return Err(
                "registration URL must be canonical HTTPS (or loopback HTTP) at /api/edge/register"
                    .to_string(),
            );
        }
        let registration_key = decode_registration_key(&encoded_registration_key)?;
        if !is_edge_label(&edge_id) || !is_edge_label(&edge_region) {
            return Err("edge id and region must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}".to_string());
        }
        let parsed_edge_url = reqwest::Url::parse(&edge_wt_url)
            .map_err(|error| format!("invalid edge public URL: {error}"))?;
        if parsed_edge_url.scheme() != "https"
            || !parsed_edge_url.username().is_empty()
            || parsed_edge_url.password().is_some()
            || parsed_edge_url.path() != "/"
            || parsed_edge_url.query().is_some()
            || parsed_edge_url.fragment().is_some()
        {
            return Err("edge public URL must be a canonical HTTPS origin".to_string());
        }
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| format!("cert registration client: {e}"))?;
        Ok(Self {
            client,
            register_url: parsed_register_url.to_string(),
            registration_key,
            edge_id,
            edge_region,
            edge_wt_url: parsed_edge_url.to_string(),
        })
    }

    /// Publish the served certificate's hash and the pair peers pin.
    #[tracing::instrument(
        name = "edge.register.publish",
        skip_all,
        fields(edge_id = %self.edge_id, outcome)
    )]
    async fn publish(&self, cert_hashes: &[String; 2]) -> Result<(), RegistrationPublishError> {
        let body = RegisterBody {
            edge_id: &self.edge_id,
            edge_region: &self.edge_region,
            edge_wt_url: &self.edge_wt_url,
            cert_hash: &cert_hashes[0],
            cert_hashes,
        };
        let encoded_body = serde_json::to_vec(&body).map_err(|error| {
            RegistrationPublishError::Permanent(format!(
                "canonical registration serialization failed: {error}"
            ))
        })?;
        let authentication = self
            .authenticate_payload(&encoded_body)
            .map_err(RegistrationPublishError::Permanent)?;
        let mut request = self
            .client
            .post(&self.register_url)
            .header(EDGE_ID_HEADER, &self.edge_id)
            .header(EDGE_TIMESTAMP_HEADER, authentication.timestamp)
            .header(EDGE_NONCE_HEADER, authentication.nonce)
            .header(EDGE_AUTH_HEADER, authentication.tag)
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        // Safe to add after authentication: the tag covers the request body,
        // not the header set, so trace context cannot invalidate it.
        if let Some(traceparent) = current_traceparent() {
            request = request.header("traceparent", traceparent);
        }
        let response = request.body(encoded_body).send().await.map_err(|error| {
            tracing::Span::current().record("outcome", "retryable");
            metrics::record_registration_publish("retryable");
            RegistrationPublishError::Retryable(format!("registration POST: {error}"))
        })?;
        let status = response.status();
        if status.is_success() {
            tracing::Span::current().record("outcome", "ok");
            metrics::record_registration_publish("ok");
            return Ok(());
        }
        let message = format!("registration rejected with HTTP {status}");
        if registration_status_is_retryable(status) {
            tracing::Span::current().record("outcome", "retryable");
            metrics::record_registration_publish("retryable");
            Err(RegistrationPublishError::Retryable(message))
        } else {
            tracing::Span::current().record("outcome", "permanent");
            metrics::record_registration_publish("permanent");
            Err(RegistrationPublishError::Permanent(message))
        }
    }

    fn authenticate_payload(&self, encoded_body: &[u8]) -> Result<RegistrationAuth, String> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system clock is before the Unix epoch".to_string())?
            .as_millis()
            .to_string();
        let mut nonce = [0_u8; REGISTRATION_NONCE_BYTES];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "secure random generation failed for registration nonce".to_string())?;
        let payload_hash = digest::digest(&digest::SHA512, encoded_body);
        let authenticated = encode_registration_authentication_input(
            &self.edge_id,
            &timestamp,
            &nonce,
            payload_hash.as_ref(),
        );
        let tag = hmac::sign(&self.registration_key, &authenticated);
        Ok(RegistrationAuth {
            timestamp,
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            tag: URL_SAFE_NO_PAD.encode(tag.as_ref()),
        })
    }

    pub async fn publish_initial(&self, cert_hashes: &[String; 2]) -> Result<(), String> {
        let mut backoff = RegistrationBackoff::new();
        loop {
            match self.publish(cert_hashes).await {
                Ok(()) => return Ok(()),
                Err(RegistrationPublishError::Retryable(error)) => {
                    let delay = backoff.next_delay();
                    warn!(
                        delay_ms = delay.as_secs_f64() * 1_000.0,
                        "edge: initial registration failed; scheduling fallback: {error}"
                    );
                    tokio::time::sleep(delay).await;
                }
                Err(RegistrationPublishError::Permanent(error)) => return Err(error),
            }
        }
    }
}

struct RegistrationAuth {
    timestamp: String,
    nonce: String,
    tag: String,
}

fn decode_registration_key(encoded: &str) -> Result<hmac::Key, String> {
    let mut decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "registration key must be canonical base64url for 64 bytes".to_string())?;
    if decoded.len() != REGISTRATION_KEY_BYTES || URL_SAFE_NO_PAD.encode(&decoded) != encoded {
        decoded.fill(0);
        return Err("registration key must be canonical base64url for 64 bytes".to_string());
    }
    let key = hmac::Key::new(hmac::HMAC_SHA512, &decoded);
    decoded.fill(0);
    Ok(key)
}

fn encode_registration_authentication_input(
    edge_id: &str,
    timestamp: &str,
    nonce: &[u8],
    payload_hash: &[u8],
) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(
        7 * size_of::<u32>()
            + REGISTRATION_AUTH_DOMAIN.len()
            + edge_id.len()
            + REGISTRATION_METHOD.len()
            + REGISTRATION_PATH.len()
            + timestamp.len()
            + nonce.len()
            + payload_hash.len(),
    );
    for field in [
        REGISTRATION_AUTH_DOMAIN,
        edge_id.as_bytes(),
        REGISTRATION_METHOD,
        REGISTRATION_PATH,
        timestamp.as_bytes(),
        nonce,
        payload_hash,
    ] {
        let length = u32::try_from(field.len()).expect("registration authentication field bounded");
        encoded.extend_from_slice(&length.to_be_bytes());
        encoded.extend_from_slice(field);
    }
    encoded
}

/// W3C `traceparent` for the current span, when one is being exported.
///
/// The server's HTTP instrumentation already calls `propagation.extract` on
/// inbound headers, so emitting this is the whole of what was missing: the edge
/// and the server shared **zero** trace ids because nothing ever sent one, and
/// registration is the only hop between them that can carry context at all
/// (browsers dial the edge directly).
///
/// Formatted exactly as `opentelemetry_sdk`'s `TraceContextPropagator` does,
/// including masking to `SAMPLED`, rather than taken as a dependency: the edge
/// injects into exactly one request and does not otherwise need a propagator.
///
/// Returns `None` when telemetry is unconfigured — `Span::current()` then has no
/// exported context and `is_valid()` is false — so an unconfigured edge sends no
/// header rather than an all-zero one.
fn current_traceparent() -> Option<String> {
    let context = tracing::Span::current().context();
    let span = context.span();
    let span_context = span.span_context();
    if !span_context.is_valid() {
        return None;
    }
    Some(format_traceparent(span_context))
}

/// Render a `SpanContext` as a W3C `traceparent` value.
///
/// Split out from `current_traceparent` purely so it can be pinned to the
/// specification's own example vector: nothing at runtime detects a malformed
/// value. The server would extract nothing, silently start a fresh trace, and
/// look exactly like the "no header sent" case this change exists to fix.
fn format_traceparent(span_context: &opentelemetry::trace::SpanContext) -> String {
    format!(
        "00-{}-{}-{:02x}",
        span_context.trace_id(),
        span_context.span_id(),
        span_context.trace_flags() & TraceFlags::SAMPLED
    )
}

fn registration_status_is_retryable(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn is_edge_label(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}

pub fn spawn(
    endpoint: Arc<Endpoint<Server>>,
    bind_addr: SocketAddr,
    subject_alt_names: Vec<String>,
    certs: EdgeCerts,
    publisher: EdgePublisher,
    identity_dir: PathBuf,
) {
    let (rotation_tx, rotation_rx) = tokio::sync::mpsc::channel(1);
    #[cfg(unix)]
    tokio::spawn(async move {
        let mut signal = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        {
            Ok(signal) => signal,
            Err(error) => {
                warn!("edge: failed to install SIGHUP rotation trigger: {error}");
                return;
            }
        };
        while signal.recv().await.is_some() {
            if rotation_tx.send(()).await.is_err() {
                return;
            }
        }
    });
    tokio::spawn(async move {
        info!(
            edge_id = %publisher.edge_id,
            edge_region = %publisher.edge_region,
            "edge: registration established; certificate rotation enabled"
        );
        if let Err(failure) = run(
            endpoint,
            bind_addr,
            subject_alt_names,
            certs,
            publisher,
            rotation_rx,
            identity_dir,
        )
        .await
        {
            error!("edge: registration maintenance stopped permanently: {failure}");
            std::process::exit(1);
        }
    });
}

async fn run(
    endpoint: Arc<Endpoint<Server>>,
    bind_addr: SocketAddr,
    subject_alt_names: Vec<String>,
    mut certs: EdgeCerts,
    publisher: EdgePublisher,
    mut rotation_rx: tokio::sync::mpsc::Receiver<()>,
    identity_dir: PathBuf,
) -> Result<(), String> {
    let names: Vec<&str> = subject_alt_names.iter().map(String::as_str).collect();
    let mut persist_pending = false;
    let mut ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
        HEARTBEAT_INTERVAL,
    );
    let mut rotation_trigger_open = true;

    loop {
        let force_rotation = tokio::select! {
            _ = ticker.tick() => false,
            rotation = rotation_rx.recv(), if rotation_trigger_open => {
                match rotation {
                    Some(()) => true,
                    None => {
                        rotation_trigger_open = false;
                        false
                    }
                }
            },
        };

        if persist_pending {
            match certs.persist(&identity_dir).await {
                Ok(()) => persist_pending = false,
                Err(error) => warn!("edge: certificate pointers still unpersisted: {error}"),
            }
        }

        if force_rotation || certs.rotation_due() {
            if force_rotation {
                info!(edge_id = %publisher.edge_id, "edge: certificate rotation requested by SIGHUP");
            }
            match rotate(&endpoint, bind_addr, &names, &identity_dir, &mut certs).await {
                Ok(persisted) => {
                    metrics::record_cert_rotation("ok");
                    persist_pending = !persisted;
                    certs.log_pins();
                }
                Err(outcome) => metrics::record_cert_rotation(outcome),
            }
        }

        // Every heartbeat restates the pair, so a lost publication heals at the
        // next one; a rotation publishes the new pair in the same turn.
        match publisher.publish(&certs.hashes_base64()).await {
            Ok(()) => info!(edge_id = %publisher.edge_id, "edge: registration heartbeat published"),
            Err(RegistrationPublishError::Retryable(error)) => {
                warn!("edge: registration heartbeat failed: {error}")
            }
            Err(RegistrationPublishError::Permanent(error)) => return Err(error),
        }
    }
}

/// Serve the published next certificate and stage its successor. Every peer
/// that learned the pair since the last rotation pins the certificate now
/// served. Returns whether the identity directory names the new pair; a failure
/// there is retried at each heartbeat, and a restart before it lands serves the
/// pair the directory names, which the registry then states again.
async fn rotate(
    endpoint: &Endpoint<Server>,
    bind_addr: SocketAddr,
    names: &[&str],
    identity_dir: &std::path::Path,
    certs: &mut EdgeCerts,
) -> Result<bool, &'static str> {
    let successor = EdgeCerts::successor(names, identity_dir)
        .await
        .map_err(|error| {
            warn!("edge: certificate rotation could not stage a successor: {error}");
            "persist_failed"
        })?;
    endpoint
        .reload_config(relay::build_server_config(&certs.next, bind_addr), false)
        .map_err(|error| {
            warn!("edge: certificate hot reload failed: {error}");
            "reload_failed"
        })?;
    certs.advance(successor);
    match certs.persist(identity_dir).await {
        Ok(()) => Ok(true),
        Err(error) => {
            warn!("edge: rotated certificate pointers unpersisted: {error}");
            Ok(false)
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "register_profile.rs"]
mod profile;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn test_registration_key() -> String {
        URL_SAFE_NO_PAD.encode([0x41_u8; REGISTRATION_KEY_BYTES])
    }

    #[test]
    fn register_body_contains_affinity_and_both_pinned_hashes() {
        let hashes = vec!["served".to_string(), "next".to_string()];
        let body = RegisterBody {
            edge_id: "iad-1",
            edge_region: "iad",
            edge_wt_url: "https://iad-1.edge.example:4433",
            cert_hash: "served",
            cert_hashes: &hashes,
        };
        let value = serde_json::to_value(body).expect("serialize registration");
        assert_eq!(value["edgeId"], "iad-1");
        assert_eq!(value["edgeRegion"], "iad");
        assert_eq!(value["edgeWtUrl"], "https://iad-1.edge.example:4433");
        assert_eq!(value["certHash"], "served");
        assert_eq!(value["certHashes"], serde_json::json!(["served", "next"]));
    }

    #[test]
    fn canonical_registration_and_authentication_match_the_server_vector() {
        let hashes = vec![
            "Qr4ZuCBq6NiQejuKBH9LF4gS6GICM00rGduNd31OVXw=".to_string(),
            "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=".to_string(),
        ];
        let body = RegisterBody {
            edge_id: "iad-1",
            edge_region: "iad",
            edge_wt_url: "https://iad-1.edge.example:4433/",
            cert_hash: &hashes[0],
            cert_hashes: &hashes,
        };
        let encoded_body = serde_json::to_vec(&body).expect("canonical registration");
        assert_eq!(
            std::str::from_utf8(&encoded_body).expect("registration is utf8"),
            "{\"edgeId\":\"iad-1\",\"edgeRegion\":\"iad\",\"edgeWtUrl\":\"https://iad-1.edge.example:4433/\",\"certHash\":\"Qr4ZuCBq6NiQejuKBH9LF4gS6GICM00rGduNd31OVXw=\",\"certHashes\":[\"Qr4ZuCBq6NiQejuKBH9LF4gS6GICM00rGduNd31OVXw=\",\"QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=\"]}"
        );
        let key = hmac::Key::new(hmac::HMAC_SHA512, &[0x41_u8; REGISTRATION_KEY_BYTES]);
        let nonce = [0x23_u8; REGISTRATION_NONCE_BYTES];
        let payload_hash = digest::digest(&digest::SHA512, &encoded_body);
        let input = encode_registration_authentication_input(
            "iad-1",
            "1700000000123",
            &nonce,
            payload_hash.as_ref(),
        );
        let tag = URL_SAFE_NO_PAD.encode(hmac::sign(&key, &input).as_ref());
        assert_eq!(
            tag,
            "yCmTEqKiCF2b9r6dzTcD9w38ZsHGrpE9eyVsOaAjovLj5xTzxnWNrQ1jwMhiGQw4JhtM6C5-Sf0mneLPlJdnjA"
        );
    }

    #[test]
    fn publisher_rejects_noncanonical_or_wrong_length_registration_keys() {
        for key in [
            "short".to_string(),
            format!("{}=", test_registration_key()),
            URL_SAFE_NO_PAD.encode([0x41_u8; REGISTRATION_KEY_BYTES - 1]),
        ] {
            assert!(
                EdgePublisher::new(
                    "https://server.example/api/edge/register".into(),
                    key,
                    "iad-1".into(),
                    "iad".into(),
                    "https://iad.edge.example:4433/".into(),
                )
                .is_err()
            );
        }
    }

    #[test]
    fn registration_backoff_full_jitter_preserves_every_ceiling() {
        let expected_ceilings_ms = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000];
        let mut minimum = RegistrationBackoff::new();
        let mut maximum = RegistrationBackoff::new();

        for expected_ceiling_ms in expected_ceilings_ms {
            assert_eq!(
                minimum.next_delay_from_sample(0),
                Duration::ZERO,
                "full jitter must include the lower bound"
            );
            assert_eq!(
                maximum.next_delay_from_sample(u64::MAX),
                Duration::from_millis(expected_ceiling_ms),
                "full jitter must never exceed the exponential ceiling"
            );
        }
    }

    #[test]
    fn registration_backoff_samples_have_nonzero_dispersion() {
        let delays: std::collections::HashSet<_> = [
            0,
            u64::MAX / 4,
            u64::MAX / 2,
            u64::MAX - (u64::MAX / 4),
            u64::MAX,
        ]
        .into_iter()
        .map(|sample| {
            RegistrationBackoff::new()
                .next_delay_from_sample(sample)
                .as_millis()
        })
        .collect();

        assert_eq!(
            delays.len(),
            5,
            "independent samples must disperse fallback attempts across the window"
        );
    }

    #[test]
    fn only_network_server_and_rate_limit_failures_are_retryable() {
        assert!(registration_status_is_retryable(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(registration_status_is_retryable(
            reqwest::StatusCode::SERVICE_UNAVAILABLE
        ));
        for permanent in [
            reqwest::StatusCode::BAD_REQUEST,
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
            reqwest::StatusCode::CONFLICT,
        ] {
            assert!(!registration_status_is_retryable(permanent));
        }
    }

    #[test]
    fn publisher_rejects_schema_drift_before_network_activity() {
        for edge_id in ["", "-iad", "iad!", &"a".repeat(65)] {
            assert!(
                EdgePublisher::new(
                    "https://server.example/api/edge/register".into(),
                    test_registration_key(),
                    edge_id.into(),
                    "iad".into(),
                    "https://iad.edge.example:4433/".into(),
                )
                .is_err()
            );
        }
        for edge_url in [
            "http://iad.edge.example/",
            "https://iad.edge.example/path",
            "https://iad.edge.example/?region=iad",
            "https://iad.edge.example/#",
        ] {
            assert!(
                EdgePublisher::new(
                    "https://server.example/api/edge/register".into(),
                    test_registration_key(),
                    "iad-1".into(),
                    "iad".into(),
                    edge_url.into(),
                )
                .is_err()
            );
        }
    }

    #[tokio::test]
    async fn registration_backoff_sleep_is_promptly_cancellation_safe() {
        let mut backoff = RegistrationBackoff::new();
        for _ in 0..5 {
            let _ = backoff.next_delay_from_sample(u64::MAX);
        }
        let sleeper = tokio::spawn(tokio::time::sleep(backoff.next_delay_from_sample(u64::MAX)));
        tokio::task::yield_now().await;
        sleeper.abort();

        let result = tokio::time::timeout(Duration::from_millis(100), sleeper)
            .await
            .expect("aborted fallback sleep must resolve promptly");
        assert!(
            result
                .expect_err("aborted fallback sleep must not complete")
                .is_cancelled(),
            "dropping the registration task must cancel its fallback wait"
        );
    }

    #[tokio::test]
    async fn a_rejected_publication_is_retried_at_the_next_heartbeat() {
        crate::install_crypto_provider();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept request");
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request).await;
            stream
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
                .await
                .expect("write rejection");
        });

        let publisher = EdgePublisher::new(
            format!("http://{address}/api/edge/register"),
            test_registration_key(),
            "iad-1".to_string(),
            "iad".to_string(),
            "https://iad-1.edge.example:4433".to_string(),
        )
        .expect("publisher");
        let hashes = ["served".to_string(), "next".to_string()];
        assert!(matches!(
            publisher.publish(&hashes).await,
            Err(RegistrationPublishError::Retryable(_))
        ));
    }
}

#[cfg(test)]
mod traceparent_tests {
    use super::format_traceparent;
    use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceId, TraceState};

    #[test]
    fn renders_the_w3c_specification_example() {
        let context = SpanContext::new(
            TraceId::from_hex("0af7651916cd43dd8448eb211c80319c").expect("trace id"),
            SpanId::from_hex("b7ad6b7169203331").expect("span id"),
            TraceFlags::SAMPLED,
            false,
            TraceState::default(),
        );

        assert_eq!(
            format_traceparent(&context),
            "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
        );
    }

    #[test]
    fn masks_everything_except_the_sampled_bit() {
        // A vendor-set flag must not leak into the header: the receiver parses
        // exactly two hex digits and a value outside the sampled bit would make
        // the whole traceparent unparseable, dropping the join silently.
        let context = SpanContext::new(
            TraceId::from_hex("0af7651916cd43dd8448eb211c80319c").expect("trace id"),
            SpanId::from_hex("b7ad6b7169203331").expect("span id"),
            TraceFlags::new(0xff),
            false,
            TraceState::default(),
        );

        assert!(format_traceparent(&context).ends_with("-01"));
    }

    #[test]
    fn renders_an_unsampled_span_as_zero_flags() {
        let context = SpanContext::new(
            TraceId::from_hex("0af7651916cd43dd8448eb211c80319c").expect("trace id"),
            SpanId::from_hex("b7ad6b7169203331").expect("span id"),
            TraceFlags::default(),
            false,
            TraceState::default(),
        );

        assert!(format_traceparent(&context).ends_with("-00"));
    }
}
