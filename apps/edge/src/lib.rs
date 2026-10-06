//! merkur-edge — Fly.io anycast WebTransport edge relay.
//!
//! A BLIND splice: it pairs a browser's native WebTransport session with the
//! matching daemon HTTP/3 tunnel session and forwards opaque, Noise-encrypted
//! frames between them WITHOUT EVER DECRYPTING THEM. The edge holds no Noise
//! keys, no password secret, and no token-signing key. See `splice.rs` for the
//! blind-relay invariant and `README.md` for the protocol and deploy notes.
//!
//! The library is the whole edge: `main.rs` only runs [`run`], and the network
//! simulator (`tools/sim`) links [`sim`] under `cfg(merkur_sim)`.

mod attach_ticket;
mod cert;
mod egress_budget;
mod endpoint_secret;
mod metrics;
#[cfg(all(test, target_os = "macos"))]
mod profile_support;
mod register;
mod relay;
#[cfg(merkur_sim)]
pub mod sim;
mod splice;
mod telemetry;

use std::env;
use std::net::{Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::Arc;

use tracing::{error, info, warn};

use crate::cert::EdgeCerts;
use crate::endpoint_secret::EndpointSecret;
use crate::splice::SpliceRegistry;

/// Default UDP/QUIC listen port. Overridable via `MERKUR_EDGE_PORT`.
const DEFAULT_PORT: u16 = 4433;

/// Install ring as the process-wide rustls provider.
///
/// `reqwest` is built with `rustls-no-provider` (the `rustls` feature would pull
/// aws-lc-rs, which needs cmake and is absent from this workspace), so every TLS
/// client in the process — the registration publisher and the OTLP exporter —
/// panics on first use unless this has run. Idempotent: a second call finds a
/// provider already installed and does nothing. Tests that construct a TLS
/// client call it too, since they never run `main`.
pub(crate) fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Report every panic through `tracing` before the default hook runs.
///
/// This is not a diagnostic nicety, it is the only way a panic in this process
/// is ever seen. A panicking Tokio task is absorbed by its `JoinHandle`, and
/// `run_spliced_session` discards those handles, so a panicking pump is
/// indistinguishable from a clean exit. Worse, quinn's connection state is a
/// `std::sync::Mutex` whose `lock()` unwraps: a panic taken while holding it
/// poisons the mutex, the next `SendStream::drop` unwraps the poison and panics
/// inside a destructor during unwinding, and that is a non-unwinding panic —
/// the whole process aborts and every spliced session on this replica dies.
/// A single panic anywhere is therefore fatal to every user on the replica, and
/// without this hook the only trace is a bare `SIGABRT` in the platform log.
///
/// Chains to the previous hook so the stderr backtrace still reaches `fly logs`.
fn install_panic_reporter() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "<unknown>".to_string());
        let thread = std::thread::current();
        error!(
            panic.location = %location,
            panic.thread = thread.name().unwrap_or("<unnamed>"),
            "edge: panic — this process aborts if it unwinds through a QUIC stream drop: {}",
            panic_message(info),
        );
        previous(info);
    }));
}

/// `PanicHookInfo::payload` is `&dyn Any`; only the two standard payload shapes
/// carry a message, and anything else has none to report.
fn panic_message<'a>(info: &'a std::panic::PanicHookInfo<'_>) -> &'a str {
    let payload = info.payload();
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        message
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.as_str()
    } else {
        "<non-string panic payload>"
    }
}

struct RegistrationConfig {
    register_url: String,
    registration_key: String,
    edge_id: String,
    edge_region: String,
    edge_wt_url: String,
    identity_dir: PathBuf,
}

/// Resolve the UDP bind address. On Fly.io, UDP services MUST bind the address
/// that `fly-global-services` resolves to inside the VM (per Fly's docs), not a
/// wildcard — otherwise no inbound datagrams are delivered. Off Fly (detected via
/// `FLY_APP_NAME`), bind the dual-stack wildcard so local runs and the probe work.
fn resolve_bind_addr(port: u16) -> SocketAddr {
    if env::var_os("FLY_APP_NAME").is_some() {
        match ("fly-global-services", port).to_socket_addrs() {
            Ok(mut addrs) => {
                if let Some(addr) = addrs.next() {
                    info!(%addr, "edge: binding fly-global-services for Fly UDP routing");
                    return addr;
                }
                warn!("edge: fly-global-services resolved to no addresses; using wildcard");
            }
            Err(e) => warn!("edge: failed to resolve fly-global-services ({e}); using wildcard"),
        }
    }
    SocketAddr::from((Ipv6Addr::UNSPECIFIED, port))
}

/// The edge process: telemetry, identity and registration, then the relay.
pub async fn run() {
    // Telemetry first: it installs the tracing subscriber, and its exporter
    // builds a TLS client, which needs the crypto provider already in place.
    let edge_id = env::var("MERKUR_EDGE_ID").unwrap_or_default();
    let edge_region = env::var("MERKUR_EDGE_REGION").unwrap_or_default();
    // Before any TLS client is built, including the OTLP exporter's.
    install_crypto_provider();
    let telemetry_config = match telemetry::config_from_env(&edge_id, &edge_region) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("edge: {error}");
            std::process::exit(1);
        }
    };
    // Held for the process lifetime; dropping it shuts the pipelines down.
    let _telemetry = match telemetry::init(telemetry_config) {
        Ok(telemetry) => telemetry,
        Err(error) => {
            eprintln!("edge: telemetry setup failed: {error}");
            std::process::exit(1);
        }
    };
    // After the subscriber exists, before anything can spawn and panic.
    install_panic_reporter();

    // Before binding: an edge that cannot verify tickets must not come up and
    // refuse every peer, and must never come up and admit them unchecked.
    let attach_tickets =
        match attach_ticket_key_from_value(env::var("MERKUR_EDGE_ATTACH_TICKET_KEY").ok()) {
            Ok(key) => key,
            Err(error) => {
                error!("edge: {error}");
                std::process::exit(1);
            }
        };

    let port = match edge_port_from_value(env::var("MERKUR_EDGE_PORT").ok()) {
        Ok(port) => port,
        Err(error) => {
            error!("edge: {error}");
            std::process::exit(1);
        }
    };

    // The SANs the self-signed cert is generated for. The browser pins the
    // SHA-256 hash, not the name, so these are advisory; the anycast hostname
    // can be supplied via MERKUR_EDGE_HOSTNAME.
    let hostname = env::var("MERKUR_EDGE_HOSTNAME").unwrap_or_else(|_| "localhost".to_string());
    let registration = match load_registration_config() {
        Ok(config) => config,
        Err(error) => {
            error!("edge: {error}");
            std::process::exit(1);
        }
    };
    // Validate the complete producer-side registration schema before binding
    // the public UDP socket. A malformed deployment must not look live on an
    // undiscoverable endpoint.
    let publisher = match register::EdgePublisher::new(
        registration.register_url.clone(),
        registration.registration_key.clone(),
        registration.edge_id.clone(),
        registration.edge_region.clone(),
        registration.edge_wt_url.clone(),
    ) {
        Ok(publisher) => publisher,
        Err(error) => {
            error!("edge: registration setup failed: {error}");
            std::process::exit(1);
        }
    };
    let subject_alt_names = vec![hostname.clone(), "localhost".to_string()];
    let subject_alt_name_refs: Vec<&str> = subject_alt_names.iter().map(String::as_str).collect();

    let certs =
        match EdgeCerts::load_or_generate(&subject_alt_name_refs, &registration.identity_dir).await
        {
            Ok(certs) => certs,
            Err(e) => {
                error!("edge: failed to load or generate self-signed certs: {e}");
                std::process::exit(1);
            }
        };
    certs.log_pins();
    let secret = match EndpointSecret::load_or_create(&registration.identity_dir).await {
        Ok(secret) => secret,
        Err(error) => {
            error!("edge: failed to load or create the endpoint secret: {error}");
            std::process::exit(1);
        }
    };

    let budget_config = match egress_budget::BudgetConfig::from_values(
        env::var("MERKUR_EDGE_DATA_BUDGET_GB").ok(),
        env::var("MERKUR_EDGE_SIGNALING_RESERVE_GB").ok(),
    ) {
        Ok(config) => config,
        Err(error) => {
            error!("edge: {error}");
            std::process::exit(1);
        }
    };
    let budget = (|| {
        let counter =
            egress_budget::NicCounter::new(env::var("MERKUR_EDGE_EGRESS_INTERFACE").ok())?;
        egress_budget::EgressBudget::load(
            &registration.identity_dir,
            budget_config,
            counter,
            egress_budget::utc_month()?,
        )
    })();
    let budget = match budget {
        Ok(budget) => budget,
        Err(error) => {
            error!("edge: egress budget setup failed: {error}");
            std::process::exit(1);
        }
    };
    let (budget_tx, budget_rx) = tokio::sync::watch::channel(budget.state());

    egress_budget::spawn_sampler(budget, budget_tx);

    let bind_addr = resolve_bind_addr(port);
    let endpoint = match relay::build_server(&certs.active, bind_addr, &secret) {
        Ok(e) => e,
        Err(e) => {
            error!("edge: failed to start WebTransport server: {e}");
            std::process::exit(1);
        }
    };

    let endpoint = Arc::new(endpoint);
    let local_addr = endpoint
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| format!("0.0.0.0:{port}"));
    // The local E2E harness owns the registration server, so it needs a
    // post-bind/pre-publication rendezvous to avoid a startup cycle. This is
    // deliberately distinct from the readiness log below: a bound socket is
    // not publicly discoverable until registration succeeds.
    info!(
        listen = %local_addr,
        "edge: WebTransport socket bound; registration pending"
    );
    if let Err(error) = publisher.publish_initial(&certs.hashes_base64()).await {
        error!("edge: initial registration failed permanently: {error}");
        std::process::exit(1);
    }
    info!(edge_id = %registration.edge_id, edge_region = %registration.edge_region, "edge: registration and certificate rotation starting");
    register::spawn(
        endpoint.clone(),
        bind_addr,
        subject_alt_names,
        certs,
        publisher,
        registration.identity_dir,
    );

    info!(
        listen = %local_addr,
        "edge: blind WebTransport relay listening (browser + daemon dial in here)"
    );

    let registry = SpliceRegistry::new();
    relay::accept_loop(endpoint, registry, Arc::new(attach_tickets), budget_rx).await;
}

fn load_registration_config() -> Result<RegistrationConfig, String> {
    registration_config_from_values([
        env::var("MERKUR_EDGE_REGISTER_URL").ok(),
        env::var("MERKUR_EDGE_REGISTRATION_KEY").ok(),
        env::var("MERKUR_EDGE_ID").ok(),
        env::var("MERKUR_EDGE_REGION").ok(),
        env::var("MERKUR_EDGE_PUBLIC_URL").ok(),
        env::var("MERKUR_EDGE_IDENTITY_DIR").ok(),
    ])
}

fn attach_ticket_key_from_value(
    value: Option<String>,
) -> Result<attach_ticket::AttachTicketKey, String> {
    let value = value.ok_or_else(|| "MERKUR_EDGE_ATTACH_TICKET_KEY is required".to_string())?;
    attach_ticket::AttachTicketKey::from_base64url(value.trim())
        .map_err(|error| format!("MERKUR_EDGE_ATTACH_TICKET_KEY: {error}"))
}

fn edge_port_from_value(value: Option<String>) -> Result<u16, String> {
    match value {
        None => Ok(DEFAULT_PORT),
        Some(value) => value
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .ok_or_else(|| "MERKUR_EDGE_PORT must be an integer from 1 to 65535".to_string()),
    }
}

fn registration_config_from_values(
    values: [Option<String>; 6],
) -> Result<RegistrationConfig, String> {
    let [
        Some(register_url),
        Some(registration_key),
        Some(edge_id),
        Some(edge_region),
        Some(edge_wt_url),
        Some(identity_dir),
    ] = values
    else {
        return Err("registration requires MERKUR_EDGE_REGISTER_URL, MERKUR_EDGE_REGISTRATION_KEY, MERKUR_EDGE_ID, MERKUR_EDGE_REGION, MERKUR_EDGE_PUBLIC_URL, and MERKUR_EDGE_IDENTITY_DIR".to_string());
    };
    for (name, value) in [
        ("MERKUR_EDGE_REGISTER_URL", &register_url),
        ("MERKUR_EDGE_REGISTRATION_KEY", &registration_key),
        ("MERKUR_EDGE_ID", &edge_id),
        ("MERKUR_EDGE_REGION", &edge_region),
        ("MERKUR_EDGE_PUBLIC_URL", &edge_wt_url),
        ("MERKUR_EDGE_IDENTITY_DIR", &identity_dir),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{name} must not be empty"));
        }
    }
    Ok(RegistrationConfig {
        register_url,
        registration_key,
        edge_id,
        edge_region,
        edge_wt_url,
        identity_dir: PathBuf::from(identity_dir),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn current_registration_values() -> [Option<String>; 6] {
        [
            Some("https://server.example/api/edge/register".to_string()),
            Some("A".repeat(86)),
            Some("iad-1".to_string()),
            Some("iad".to_string()),
            Some("https://iad-1.edge.example:4433".to_string()),
            Some("/var/lib/merkur-edge".to_string()),
        ]
    }

    #[test]
    fn registration_is_mandatory() {
        assert!(registration_config_from_values(Default::default()).is_err());

        for missing in 0..6 {
            let mut values = current_registration_values();
            values[missing] = None;
            assert!(registration_config_from_values(values).is_err());
        }
    }

    #[test]
    fn complete_registration_is_accepted() {
        let config =
            registration_config_from_values(current_registration_values()).expect("current config");
        assert_eq!(config.edge_id, "iad-1");
        assert_eq!(config.edge_region, "iad");
        assert_eq!(config.identity_dir, PathBuf::from("/var/lib/merkur-edge"));
    }

    #[test]
    fn the_attach_ticket_key_is_mandatory() {
        assert!(attach_ticket_key_from_value(None).is_err());
        assert!(attach_ticket_key_from_value(Some(String::new())).is_err());
        assert!(attach_ticket_key_from_value(Some("A".repeat(86))).is_ok());
    }

    #[test]
    fn configured_edge_port_is_exact_and_never_falls_back() {
        assert_eq!(edge_port_from_value(None), Ok(DEFAULT_PORT));
        assert_eq!(edge_port_from_value(Some("4433".to_string())), Ok(4433));
        for invalid in ["", "0", "-1", "65536", "4433.5", "not-a-port"] {
            assert!(edge_port_from_value(Some(invalid.to_string())).is_err());
        }
    }
}
