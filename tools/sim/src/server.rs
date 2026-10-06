//! The server's half of a session, in process: one account, the client it
//! delegated to, the daemon it linked, and the capabilities the server mints
//! for them. Every record is built by the implementation production uses
//! (`merkur-authorization`, `merkur-e2e`, the edge's ticket key); the session
//! capability is the one record the server writes in TypeScript, so its
//! encoder here is pinned to the server's vector (`tests/issuer.rs`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use futures::future::BoxFuture;
use merkur_authorization::{
    DELEGATION_LIFETIME_MS, DELEGATION_SCOPES, DaemonBinding, DaemonBindingPayload,
    DelegationCertificate, DelegationPayload, SigningKey, daemon_identity_key_commitment,
    decode_len, encode, root_key_commitment,
};
use merkur_client::auth::Delegation;
use merkur_client::issuance::{Issuance, IssuanceRequest, RenewalCapability, RenewalRequest};
use merkur_client_native::account::AccountError;
use merkur_client_native::issuer::Issuer;
use merkur_e2e::SoftwareP256SigningKey;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot, watch};

pub const ORIGIN: &str = "https://merkur.sim";
pub const USER_ID: &str = "user-1";
pub const DELEGATION_ID: &str = "delegation-1";
pub const DAEMON_ID: &str = "daemon-1";
pub const EDGE_HOST: &str = "edge";
pub const EDGE_PORT: u16 = 4433;
/// `KEY_LEN` in `apps/edge/src/attach_ticket.rs`.
pub const EDGE_TICKET_KEY_BYTES: usize = 64;
/// `SESSION_AUTHORIZATION_CONTEXT` in `packages/auth/src/session-authorization.ts`.
const SESSION_AUTHORIZATION_CONTEXT: &[u8] = b"merkur-session-authorization";
/// `SESSION_AUTHORIZATION_MAX_LIFETIME_MS`, the lifetime the server mints.
const SESSION_TOKEN_LIFETIME_MS: u64 = 300_000;
/// The server's daemon attach ticket lifetime; a fresh one rides every lease.
pub const DAEMON_TICKET_LIFETIME_SECS: u64 = 90;

/// One user, one delegated client, one linked daemon. Keys come from fixed
/// seeds, so every run of every seed authenticates the same principals;
/// signing randomness comes from the run's entropy.
pub struct Account {
    root: SigningKey,
    delegate: Arc<SigningKey>,
    certificate: DelegationCertificate,
    daemon_seed: [u8; 32],
    daemon_public_key: Vec<u8>,
    daemon_p256_public_key: [u8; 65],
    binding: DaemonBinding,
    token_key: SigningKey,
    edge_ticket_key: [u8; EDGE_TICKET_KEY_BYTES],
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_seed(&mut [seed; 32]).expect("an ML-DSA-87 key from a seed")
}

fn randomness() -> [u8; 32] {
    let mut bytes = [0; 32];
    assert!(
        crate::entropy::fill(&mut bytes),
        "records are signed inside a run"
    );
    bytes
}

/// Wall time in milliseconds, which inside a host is the simulated clock.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("simulated wall time is after the epoch")
        .as_millis() as u64
}

impl Account {
    pub fn new() -> Self {
        let root = key(0x11);
        let delegate = key(0x22);
        let now = now_ms();
        let commitment = root_key_commitment(root.public_key()).expect("a root commitment");
        let certificate = DelegationCertificate::create(
            DelegationPayload {
                user_id: USER_ID.into(),
                root_key_commitment: commitment.clone(),
                delegation_id: DELEGATION_ID.into(),
                delegate_public_key: encode(delegate.public_key()),
                scopes: DELEGATION_SCOPES
                    .iter()
                    .map(|scope| scope.to_string())
                    .collect(),
                server_origin: ORIGIN.into(),
                root_epoch: 1,
                issued_at: now,
                expires_at: now + DELEGATION_LIFETIME_MS,
            },
            &root,
            randomness(),
        )
        .expect("a delegation");
        // The software seal's material is this seed; ML-DSA-87 expands from it
        // and P-256 derives from it, as `merkur-identity-seal` opens it.
        let daemon_seed = [0x44; 32];
        let daemon = SigningKey::from_seed(&mut daemon_seed.clone()).expect("a daemon identity");
        let daemon_p256_public_key = SoftwareP256SigningKey::from_seed(&daemon_seed)
            .expect("a daemon P-256 key")
            .public_key();
        let binding = DaemonBinding::create(
            DaemonBindingPayload {
                user_id: USER_ID.into(),
                root_key_commitment: commitment,
                daemon_id: DAEMON_ID.into(),
                daemon_identity_key_commitment: daemon_identity_key_commitment(
                    daemon.public_key(),
                    &daemon_p256_public_key,
                )
                .expect("a daemon identity commitment"),
                server_origin: ORIGIN.into(),
                link_claim_id: "claim-1".into(),
                issued_at: now,
            },
            &root,
            randomness(),
        )
        .expect("a daemon binding");
        Self {
            root,
            delegate: Arc::new(delegate),
            certificate,
            daemon_seed,
            daemon_public_key: daemon.public_key().to_vec(),
            daemon_p256_public_key,
            binding,
            token_key: key(0x33),
            edge_ticket_key: [0x55; EDGE_TICKET_KEY_BYTES],
        }
    }

    /// What the client signs in with: the certificate and the root that pins
    /// every binding. The delegate key stays with the host ([`Self::delegate`]).
    pub fn delegation(&self) -> Delegation {
        let mut root_public_key = Box::new([0u8; merkur_authorization::PUBLIC_KEY_BYTES]);
        root_public_key.copy_from_slice(self.root.public_key());
        Delegation {
            certificate: self.certificate.clone(),
            root_public_key,
            server_origin: ORIGIN.into(),
        }
    }

    pub fn delegate(&self) -> Arc<SigningKey> {
        Arc::clone(&self.delegate)
    }

    pub fn edge_ticket_key(&self) -> &[u8; EDGE_TICKET_KEY_BYTES] {
        &self.edge_ticket_key
    }

    /// The daemon's `configure` command, exactly as the Bun daemon writes it.
    pub fn configure(&self) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "session_token_verify_key": encode(self.token_key.public_key()),
            "daemon_id": DAEMON_ID,
            "daemon_identity_seal": { "backend": "software", "material": encode(&self.daemon_seed) },
            "server_origin": ORIGIN,
            "user_root_public_key": encode(self.root.public_key()),
            "root_epoch": 1,
            "daemon_binding": self.binding,
            "revoked_delegations": [],
        }))
        .expect("a configure command")
    }

    /// A daemon attach ticket valid for the server's lifetime from now.
    pub fn daemon_ticket(&self) -> String {
        merkur_edge::sim::issue_ticket(
            &self.edge_ticket_key,
            merkur_edge::sim::Role::Daemon,
            DAEMON_ID,
            "",
            now_ms() / 1_000 + DAEMON_TICKET_LIFETIME_SECS,
        )
        .expect("a daemon attach ticket")
    }

    /// The session capability for `request`, as `createSessionAuthorizationToken`
    /// writes it for an issuance: bound to the client's one-use bootstrap.
    fn session_token(
        &self,
        request: &IssuanceRequest,
        session_id: &str,
        issued_at_ms: u64,
    ) -> Result<String, &'static str> {
        let nonce =
            decode_len(&request.client_nonce, 32, "client nonce").map_err(|_| "client nonce")?;
        let key = decode_len(&request.encapsulation_key, 1_568, "encapsulation key")
            .map_err(|_| "encapsulation key")?;
        let request_commitment = merkur_e2e::compute_session_request_commitment(&nonce, &key)
            .map_err(|_| "request commitment")?;
        self.capability(
            &request.delegation_id,
            &request.browser_node_id,
            session_id,
            &encode(&request_commitment),
            issued_at_ms,
        )
    }

    /// A capability over `commitment`: the bootstrap's for an issuance, the
    /// renewal intent's for a renewal, as the server's session service signs
    /// both.
    fn capability(
        &self,
        delegation_id: &str,
        browser_node_id: &str,
        session_id: &str,
        commitment: &str,
        issued_at_ms: u64,
    ) -> Result<String, &'static str> {
        let identity_commitment =
            daemon_identity_key_commitment(&self.daemon_public_key, &self.daemon_p256_public_key)
                .map_err(|_| "identity commitment")?;
        Ok(session_token(
            &self.token_key,
            &SessionTokenPayload {
                u: USER_ID,
                g: delegation_id,
                b: browser_node_id,
                d: DAEMON_ID,
                s: session_id,
                k: &identity_commitment,
                q: commitment,
                iat: issued_at_ms,
                e: issued_at_ms + SESSION_TOKEN_LIFETIME_MS,
            },
            randomness(),
        ))
    }
}

impl Default for Account {
    fn default() -> Self {
        Self::new()
    }
}

/// `SessionAuthorizationPayload`'s fields in `JSON.stringify` order.
#[derive(Serialize)]
pub struct SessionTokenPayload<'a> {
    pub u: &'a str,
    pub g: &'a str,
    pub b: &'a str,
    pub d: &'a str,
    pub s: &'a str,
    pub k: &'a str,
    pub q: &'a str,
    pub iat: u64,
    pub e: u64,
}

/// `payload.signature`, both unpadded base64url; the signature covers the
/// payload segment exactly as transported.
pub fn session_token(
    key: &SigningKey,
    payload: &SessionTokenPayload<'_>,
    randomness: [u8; 32],
) -> String {
    let segment = encode(&serde_json::to_vec(payload).expect("a token payload"));
    let signature = key
        .sign_with_context(
            SESSION_AUTHORIZATION_CONTEXT,
            segment.as_bytes(),
            randomness,
        )
        .expect("a token signature");
    format!("{segment}.{}", encode(&signature))
}

/// What the server's control plane hands the daemon.
pub enum Control {
    /// A session to start, answered once the dataplane accepted or refused it.
    Start {
        command: Vec<u8>,
        command_id: String,
        accepted: oneshot::Sender<bool>,
    },
    /// A session its client superseded with a fresh issuance.
    Cancel { command: Vec<u8> },
}

/// One issuance, by the id its client named it with.
struct Issued {
    issuance_id: String,
    session_id: String,
    browser_node_id: String,
}

/// The account API's issuance and renewal routes. An issuance reaches the
/// daemon as its control plane's `session_start` before the client hears it,
/// as the server's issuance service delivers it; one that supersedes an
/// earlier issuance first retracts that session.
pub struct Server {
    account: Arc<Account>,
    /// The edge's certificate hashes, the served one's then the next one's,
    /// as its registration last stated them.
    edge_cert: watch::Receiver<Option<[[u8; 32]; 2]>>,
    daemon: mpsc::Sender<Control>,
    issuances: Mutex<Vec<Issued>>,
    cancels: AtomicU64,
    renewals: AtomicU64,
}

/// The one edge's WebTransport URL, as its registration names it.
pub fn edge_url() -> String {
    format!("https://{}:{EDGE_PORT}", turmoil::lookup(EDGE_HOST))
}

/// Certificate hashes in the spelling the server hands out.
pub fn cert_hashes_base64(hashes: &[[u8; 32]; 2]) -> Vec<String> {
    use base64::Engine;
    hashes
        .iter()
        .map(|hash| base64::engine::general_purpose::STANDARD.encode(hash))
        .collect()
}

impl Server {
    pub fn new(
        account: Arc<Account>,
        edge_cert: watch::Receiver<Option<[[u8; 32]; 2]>>,
        daemon: mpsc::Sender<Control>,
    ) -> Self {
        Self {
            account,
            edge_cert,
            daemon,
            issuances: Mutex::new(Vec::new()),
            cancels: AtomicU64::new(0),
            renewals: AtomicU64::new(0),
        }
    }

    /// Sessions issued, sessions retracted for a successor, and capabilities
    /// renewed.
    pub fn issued(&self) -> u64 {
        self.issuances.lock().expect("issuances").len() as u64
    }

    pub fn cancelled(&self) -> u64 {
        self.cancels.load(Ordering::Relaxed)
    }

    pub fn renewed(&self) -> u64 {
        self.renewals.load(Ordering::Relaxed)
    }

    pub fn account(&self) -> &Account {
        &self.account
    }

    /// Waits until an edge has registered its certificate.
    pub async fn edge_ready(&self) {
        let mut cert = self.edge_cert.clone();
        let _ = cert.wait_for(Option::is_some).await;
    }

    async fn issue_session(&self, request: IssuanceRequest) -> Result<Box<Issuance>, AccountError> {
        let refused = |status: u16, code: &str| AccountError::Refused {
            status,
            code: code.into(),
        };
        if request.daemon_id != DAEMON_ID || request.delegation_id != DELEGATION_ID {
            return Err(refused(400, "unknown_daemon"));
        }
        let Some(hashes) = *self.edge_cert.borrow() else {
            return Err(refused(503, "no_edge"));
        };
        let edge_url = edge_url();
        let cert_hashes = cert_hashes_base64(&hashes);
        // The predecessor is retracted before its successor starts.
        let predecessor = request
            .supersedes_issuance_id
            .as_ref()
            .and_then(|superseded| {
                let issuances = self.issuances.lock().expect("issuances");
                issuances
                    .iter()
                    .find(|issued| issued.issuance_id == *superseded)
                    .map(|issued| (issued.session_id.clone(), issued.browser_node_id.clone()))
            });
        let number = self.issued() + 1;
        if let Some((session_id, browser_node_id)) = predecessor {
            let command = serde_json::to_vec(&serde_json::json!({
                "command_id": format!("cancel-{number}"),
                "session_id": session_id,
                "browser_node_id": browser_node_id,
            }))
            .expect("a session_cancel command");
            if self.daemon.send(Control::Cancel { command }).await.is_ok() {
                self.cancels.fetch_add(1, Ordering::Relaxed);
            }
        }
        let session_id = format!("session-{number}");
        let issued_at = now_ms();
        let token = self
            .account
            .session_token(&request, &session_id, issued_at)
            .map_err(|code| refused(400, code))?;
        let command_id = format!("start-{number}");
        let command = serde_json::to_vec(&serde_json::json!({
            "command_id": command_id,
            "user_id": USER_ID,
            "delegation_id": request.delegation_id,
            "session_id": session_id,
            "browser_node_id": request.browser_node_id,
            "client_nonce": request.client_nonce,
            "encapsulation_key": request.encapsulation_key,
            "edge_wt_url": edge_url,
            "edge_cert_hashes": cert_hashes,
        }))
        .expect("a session_start command");
        let (accepted, answer) = oneshot::channel();
        let delivered = self
            .daemon
            .send(Control::Start {
                command,
                command_id,
                accepted,
            })
            .await
            .is_ok();
        if !delivered || answer.await != Ok(true) {
            return Err(refused(503, "daemon_offline"));
        }
        let ticket = merkur_edge::sim::issue_ticket(
            &self.account.edge_ticket_key,
            merkur_edge::sim::Role::Browser,
            DAEMON_ID,
            &session_id,
            0,
        )
        .map_err(|_| refused(400, "attach_ticket"))?;
        self.issuances.lock().expect("issuances").push(Issued {
            issuance_id: request.issuance_id.clone(),
            session_id: session_id.clone(),
            browser_node_id: request.browser_node_id.clone(),
        });
        Ok(Box::new(Issuance {
            daemon_id: DAEMON_ID.into(),
            daemon_identity_public_key: encode(&self.account.daemon_public_key),
            daemon_identity_p256_public_key: encode(&self.account.daemon_p256_public_key),
            daemon_binding: self.account.binding.clone(),
            session_token: token,
            session_token_expires_at_ms: issued_at + SESSION_TOKEN_LIFETIME_MS,
            session_token_expires_in_ms: SESSION_TOKEN_LIFETIME_MS,
            session_id,
            edge_wt_url: edge_url,
            edge_cert_hashes: cert_hashes,
            edge_attach_ticket: ticket,
        }))
    }

    /// A fresh capability over the renewal intent's commitment, and the named
    /// edge's hashes as its registration states them now. The capability
    /// grants nothing alone: the daemon also checks the lineage MAC and the
    /// delegate's signature.
    fn renew_session(&self, request: &RenewalRequest) -> Result<RenewalCapability, AccountError> {
        let refused = |code: &str| AccountError::Refused {
            status: 400,
            code: code.into(),
        };
        if request.daemon_id != DAEMON_ID || request.delegation_id != DELEGATION_ID {
            return Err(refused("unknown_daemon"));
        }
        let session_token = self
            .account
            .capability(
                &request.delegation_id,
                &request.browser_node_id,
                &request.session_id,
                &request.commitment,
                now_ms(),
            )
            .map_err(refused)?;
        self.renewals.fetch_add(1, Ordering::Relaxed);
        let edge_cert_hashes = (request.edge_wt_url == edge_url())
            .then(|| *self.edge_cert.borrow())
            .flatten()
            .map(|hashes| cert_hashes_base64(&hashes));
        Ok(RenewalCapability {
            session_token,
            session_token_expires_in_ms: SESSION_TOKEN_LIFETIME_MS,
            edge_cert_hashes,
        })
    }
}

impl Issuer for Server {
    fn origin(&self) -> &str {
        ORIGIN
    }

    fn issue(
        &self,
        request: IssuanceRequest,
    ) -> BoxFuture<'_, Result<Box<Issuance>, AccountError>> {
        Box::pin(self.issue_session(request))
    }

    fn renew(
        &self,
        request: RenewalRequest,
    ) -> BoxFuture<'_, Result<RenewalCapability, AccountError>> {
        Box::pin(async move { self.renew_session(&request) })
    }
}
