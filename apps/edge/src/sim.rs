//! The relay as the network simulator (`tools/sim`) runs it: an identity held
//! in memory across a host's restarts as the identity directory holds it, and
//! no registration, telemetry or egress budget. Compiled only under
//! `cfg(merkur_sim)`.

use std::net::{Ipv6Addr, SocketAddr};
use std::sync::Arc;

use wtransport::Endpoint;
use wtransport::endpoint::endpoint_side::Server;

use crate::attach_ticket::{AttachTicketKey, KEY_LEN, TicketRole};
use crate::cert::EdgeCert;
use crate::egress_budget::BudgetState;
use crate::endpoint_secret::EndpointSecret;
use crate::relay;
use crate::splice::SpliceRegistry;

/// What an edge keeps in its identity directory across restarts: the
/// certificate it serves, the one it serves next, and the secret its stateless
/// resets are keyed by.
pub struct Identity {
    active: EdgeCert,
    next: EdgeCert,
    secret: EndpointSecret,
}

impl Identity {
    pub fn generate() -> Result<Self, String> {
        crate::install_crypto_provider();
        Ok(Self {
            active: EdgeCert::generate(&["edge"])?,
            next: EdgeCert::generate(&["edge"])?,
            secret: EndpointSecret::generate()?,
        })
    }

    /// This identity one rotation on: it serves its next certificate and
    /// publishes a fresh one, under the same reset secret.
    pub fn rotated(&self) -> Result<Self, String> {
        Ok(Self {
            active: self.next.duplicate(),
            next: EdgeCert::generate(&["edge"])?,
            secret: self.secret.duplicate(),
        })
    }

    /// The SHA-256 hashes peers pin, as the registry states them: the served
    /// certificate's, then the next one's.
    pub fn cert_hashes(&self) -> [[u8; 32]; 2] {
        [self.active.cert_hash, self.next.cert_hash]
    }
}

/// A bound edge, ready to serve.
pub struct Edge {
    endpoint: Arc<Endpoint<Server>>,
    bind_addr: SocketAddr,
    tickets: Arc<AttachTicketKey>,
}

impl Edge {
    /// Binds the relay on `port` of the current simulated host as `identity`,
    /// verifying attach tickets under `ticket_key`.
    pub fn bind(
        port: u16,
        ticket_key: &[u8; KEY_LEN],
        identity: &Identity,
    ) -> Result<Self, String> {
        crate::install_crypto_provider();
        let bind_addr = SocketAddr::from((Ipv6Addr::UNSPECIFIED, port));
        let endpoint = relay::build_server(&identity.active, bind_addr, &identity.secret)?;
        Ok(Self {
            endpoint: Arc::new(endpoint),
            bind_addr,
            tickets: Arc::new(AttachTicketKey::new(ticket_key)),
        })
    }

    /// Serve `identity`'s certificate from now on, as a rotation's hot reload
    /// does: established connections keep theirs.
    pub fn reload(&self, identity: &Identity) -> Result<(), String> {
        self.endpoint
            .reload_config(
                relay::build_server_config(&identity.active, self.bind_addr),
                false,
            )
            .map_err(|error| format!("edge reload: {error}"))
    }

    /// Relays until the host ends, with the egress budget always open.
    pub async fn serve(&self) {
        let (_budget, budget) = tokio::sync::watch::channel(BudgetState::Open);
        relay::accept_loop(
            Arc::clone(&self.endpoint),
            SpliceRegistry::new(),
            Arc::clone(&self.tickets),
            budget,
        )
        .await;
    }
}

/// Which end of a splice a ticket admits.
pub enum Role {
    Browser,
    Daemon,
}

/// Mints an attach ticket as the server does, with the one Rust implementation
/// the conformance vector pins.
pub fn issue_ticket(
    ticket_key: &[u8; KEY_LEN],
    role: Role,
    daemon_id: &str,
    session_id: &str,
    expiry_unix_secs: u64,
) -> Result<String, String> {
    let role = match role {
        Role::Browser => TicketRole::Browser,
        Role::Daemon => TicketRole::Daemon,
    };
    AttachTicketKey::new(ticket_key)
        .issue(role, daemon_id, session_id, expiry_unix_secs)
        .map_err(|error| format!("attach ticket: {error:?}"))
}
