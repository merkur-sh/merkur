//! The native socket owner. Gathering and checks never hold the driver turn.

use std::net::SocketAddr;
use std::sync::Arc;

use base64::Engine;
use futures::FutureExt;
use merkur_client::session::{NativeTraversalSetup, Session};
use merkur_wire::traversal::{Binding, Candidate, Snapshot};
use serde::Deserialize;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use zeroize::{Zeroize, Zeroizing};

use crate::account::AccountError;
use crate::issuer::Issuer;

pub mod socket;
pub use socket::SocketBinding;

/// Only the requester's message key is here. The observation-verification key
/// belongs to the daemon and never crosses the client API boundary.
pub struct Credential {
    pub ticket: String,
    pub secret: Zeroizing<String>,
    pub servers: Vec<String>,
    pub expires_at: Instant,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialWire {
    ticket: String,
    secret: String,
    servers: Vec<String>,
    lifetime_ms: u64,
}

impl Drop for CredentialWire {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

impl Credential {
    pub fn parse(json: &[u8]) -> Option<Self> {
        let mut wire: CredentialWire = serde_json::from_slice(json).ok()?;
        let decoder = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let secret = Zeroizing::new(decoder.decode(&wire.secret).ok()?);
        if decoder.decode(&wire.ticket).ok()?.len() != 41
            || secret.len() != 32
            || wire.servers.is_empty()
            || wire.servers.len() > 8
            || wire
                .servers
                .iter()
                .any(|server| server.is_empty() || server.len() > 256)
            || wire.lifetime_ms == 0
            || wire.lifetime_ms > 15 * 60 * 1000
        {
            return None;
        }
        Some(Self {
            ticket: std::mem::take(&mut wire.ticket),
            secret: Zeroizing::new(std::mem::take(&mut wire.secret)),
            servers: std::mem::take(&mut wire.servers),
            expires_at: Instant::now() + std::time::Duration::from_millis(wire.lifetime_ms),
        })
    }

    /// No observer evidence grants no public candidate. Local checks still
    /// use owned bindings when discovery is unavailable, including simulation.
    pub fn without_observers() -> Self {
        Self {
            ticket: String::new(),
            secret: Zeroizing::new(String::new()),
            servers: Vec::new(),
            expires_at: Instant::now(),
        }
    }
}

#[derive(Default)]
struct Tasks(Vec<JoinHandle<()>>, Vec<JoinHandle<()>>);
impl Tasks {
    fn clear(&mut self) {
        for task in self.0.drain(..) {
            task.abort();
            self.1.push(task);
        }
        reap_finished(&mut self.1, "discovery");
    }

    async fn stop(&mut self) {
        self.clear();
        drain_tasks(std::mem::take(&mut self.1), "discovery").await;
    }
}

pub(super) fn reap_finished(tasks: &mut Vec<JoinHandle<()>>, kind: &'static str) {
    tasks.retain_mut(|task| {
        if !task.is_finished() {
            return true;
        }
        match task.now_or_never() {
            Some(result) => {
                observe_completion(result, kind);
                false
            }
            None => true,
        }
    });
}

pub(super) async fn drain_tasks(tasks: Vec<JoinHandle<()>>, kind: &'static str) {
    for task in tasks {
        observe_completion(task.await, kind);
    }
}

fn observe_completion(result: Result<(), tokio::task::JoinError>, kind: &'static str) {
    if let Err(error) = result {
        if error.is_cancelled() {
            tracing::debug!(kind, "native task cancelled");
        } else {
            tracing::warn!(kind, %error, "native task failed");
        }
    }
}
impl Drop for Tasks {
    fn drop(&mut self) {
        self.clear();
    }
}

pub(super) enum Notice {
    Prepared {
        lineage: u32,
        network: u64,
        work: u64,
        next_id: u64,
        credential: Arc<Credential>,
        credential_failed: bool,
        bindings: Vec<(Arc<SocketBinding>, Vec<Candidate>)>,
    },
    Checked {
        lineage: u32,
        network: u64,
        client_generation: u64,
        manifest: u64,
        binding: u64,
        address: SocketAddr,
    },
    Exhausted {
        lineage: u32,
        network: u64,
        client_generation: u64,
        manifest: u64,
        binding: u64,
    },
    Checking {
        lineage: u32,
        network: u64,
        client_generation: u64,
        manifest: u64,
        binding: u64,
    },
    Retry {
        lineage: u32,
        network: u64,
        work: u64,
        generation: u64,
    },
    Expired {
        lineage: u32,
        network: u64,
        work: u64,
        generation: u64,
    },
    Observed {
        lineage: u32,
        network: u64,
        work: u64,
        binding: u64,
        gathered: socket::Gathered,
        complete: bool,
    },
    Candidates {
        lineage: u32,
        network: u64,
        work: u64,
        binding: u64,
        candidates: Vec<Candidate>,
    },
    Denied {
        lineage: u32,
        network: u64,
        work: u64,
        error: AccountError,
    },
}

pub(super) struct Owner {
    lineage: Option<u32>,
    network: u64,
    work: u64,
    recovery: u64,
    authorities: Vec<merkur_traversal::check::Authority>,
    requested: Option<(u32, u64)>,
    setup: Option<NativeTraversalSetup>,
    credential: Option<Arc<Credential>>,
    gather: Tasks,
    checks: Tasks,
    workers: Vec<JoinHandle<()>>,
    bindings: Vec<(Arc<SocketBinding>, Vec<Candidate>)>,
    generation: u64,
    next_id: u64,
    offered: Option<(u64, u64)>,
    events: mpsc::Sender<Notice>,
    received: mpsc::Receiver<Notice>,
    updates: Option<mpsc::Sender<(u64, Vec<Candidate>)>>,
    observing: Vec<u64>,
    checking: Vec<u64>,
    finished: Vec<u64>,
    retry_at: Option<Instant>,
    credential_deadline: Option<Instant>,
    credential_expired: bool,
    failures: u32,
    credential_failed: bool,
    opening_failed: bool,
}

impl Owner {
    pub fn new() -> Self {
        let (events, received) = mpsc::channel(32);
        Self {
            lineage: None,
            network: 1,
            work: 0,
            recovery: 0,
            authorities: Vec::new(),
            requested: None,
            setup: None,
            credential: None,
            gather: Tasks::default(),
            checks: Tasks::default(),
            workers: Vec::new(),
            bindings: Vec::new(),
            generation: 0,
            next_id: 1,
            offered: None,
            events,
            received,
            updates: None,
            observing: Vec::new(),
            checking: Vec::new(),
            finished: Vec::new(),
            retry_at: None,
            credential_deadline: None,
            credential_expired: false,
            failures: 0,
            credential_failed: false,
            opening_failed: false,
        }
    }

    pub fn network_changed(&mut self, session: &mut Session) {
        self.network = self
            .network
            .checked_add(1)
            .expect("native network generation exhausted");
        self.gather.clear();
        self.clear_checks();
        self.requested = None;
        self.offered = None;
        // Live carriers retain their Arc and their lease until they retire.
        self.bindings.clear();
        self.credential = None;
        self.credential_deadline = None;
        self.updates = None;
        self.retry_at = None;
        self.failures = 0;
        session.native_network_changed();
    }

    pub fn quiesce(&mut self) {
        self.clear_checks();
        self.gather.clear();
        self.received.close();
        while let Ok(notice) = self.received.try_recv() {
            drop(notice);
        }
        self.updates = None;
    }

    pub async fn shutdown(&mut self) {
        self.quiesce();
        self.bindings.clear();
        self.setup = None;
        self.credential = None;
        self.gather.stop().await;
        self.checks.stop().await;
        // A producer may have reserved channel capacity before close. Joining
        // every producer closes that handoff before its last bindings drain.
        while let Ok(notice) = self.received.try_recv() {
            drop(notice);
        }
        drain_tasks(std::mem::take(&mut self.workers), "router_maintenance").await;
    }

    fn register_worker(&mut self, task: JoinHandle<()>) {
        reap_finished(&mut self.workers, "router_maintenance");
        self.workers.push(task);
    }

    pub fn synchronize(&mut self, session: &Session, issuer: &Arc<dyn Issuer>) {
        let Some(lineage) = self.synchronize_scope(session) else {
            return;
        };
        if self.requested != Some((lineage, self.network)) {
            self.begin_gather(session, issuer, lineage);
        }
        self.refresh_checks(session, lineage);
    }

    fn synchronize_scope(&mut self, session: &Session) -> Option<u32> {
        let epoch = session.native_traversal_epoch();
        if epoch != self.lineage {
            self.gather.clear();
            self.clear_checks();
            self.setup = None;
            self.credential = None;
            self.credential_deadline = None;
            self.credential_expired = false;
            self.updates = None;
            self.requested = None;
            self.offered = None;
            self.lineage = epoch;
            self.retry_at = None;
            self.failures = 0;
            if epoch.is_none() {
                self.bindings.clear();
            }
        }
        let lineage = epoch?;
        if session.native_direct_live() {
            let had_work =
                !self.gather.0.is_empty() || !self.authorities.is_empty() || self.offered.is_some();
            self.clear_checks();
            self.gather.clear();
            self.offered = None;
            self.updates = None;
            self.observing.clear();
            self.credential_deadline = None;
            self.retry_at = None;
            self.failures = 0;
            if had_work {
                self.work = self.work.checked_add(1)?;
            }
            return None;
        }
        if self.credential_expired && session.native_direct_attempt_pending() {
            return None;
        }
        if session.native_traversal_recovery_generation() != self.recovery {
            self.recovery = session.native_traversal_recovery_generation();
            self.clear_checks();
            self.requested = None;
            self.offered = None;
            self.credential = None;
            self.updates = None;
        }
        Some(lineage)
    }

    fn begin_gather(&mut self, session: &Session, issuer: &Arc<dyn Issuer>, lineage: u32) {
        let Some(mut setup) = session.native_traversal_setup() else {
            return;
        };
        self.gather.clear();
        self.clear_checks();
        self.credential = None;
        self.credential_deadline = None;
        self.credential_expired = false;
        self.updates = None;
        self.work = self
            .work
            .checked_add(1)
            .expect("native discovery work generation exhausted");
        self.credential_failed = false;
        self.opening_failed = false;
        self.retry_at = None;
        self.observing.clear();
        self.generation = self
            .generation
            .checked_add(1)
            .expect("native candidate generation exhausted");
        setup.request.generation = self.generation;
        self.requested = Some((lineage, self.network));
        self.setup = Some(setup);
        let setup = self.setup.as_ref().expect("installed setup");
        let request = setup.request.clone();
        let existing = self
            .bindings
            .iter()
            .map(|(binding, _)| binding.clone())
            .collect();
        let (issuer, events, network, work, mut next_id) = (
            issuer.clone(),
            self.events.clone(),
            self.network,
            self.work,
            self.next_id,
        );
        self.gather.0.push(tokio::spawn(async move {
            let (credential, credential_failed) = match issuer.stun(request).await {
                Ok(credential) => (credential, false),
                Err(error) if error.authorization_denied() => {
                    let _delivery = events
                        .send(Notice::Denied {
                            lineage,
                            network,
                            work,
                            error,
                        })
                        .await;
                    return;
                }
                Err(_) => {
                    tracing::debug!(
                        lineage,
                        network,
                        work,
                        stage = "credential",
                        outcome = "unavailable"
                    );
                    (Credential::without_observers(), true)
                }
            };
            let credential = Arc::new(credential);
            let sockets = socket::open(existing, &mut next_id);
            // Socket descriptors permit LAN/overlay checks immediately.
            // Public observation and router admission run beside them.
            let bindings = sockets
                .into_iter()
                .map(|binding| (binding, Vec::new()))
                .collect();
            let _delivery = events
                .send(Notice::Prepared {
                    lineage,
                    network,
                    work,
                    next_id,
                    credential,
                    credential_failed,
                    bindings,
                })
                .await;
        }));
    }

    fn refresh_checks(&mut self, session: &Session, lineage: u32) {
        let Some(offer) = session.native_traversal_offer() else {
            self.schedule_retry(session);
            return;
        };
        if self.offered == Some((offer.client_generation, offer.generation))
            || offer.client_generation != self.generation
        {
            self.schedule_retry(session);
            return;
        }
        let Some(key) = self.setup.as_ref().map(|setup| setup.key.clone()) else {
            return;
        };
        self.clear_checks();
        self.offered = Some((offer.client_generation, offer.generation));
        let quota = Arc::new(Semaphore::new(merkur_traversal::check::MAX_CHECKS_PER_PEER));
        for (socket, _) in &self.bindings {
            let Ok(keys) = key.checks(offer.client_generation, offer.generation, socket.id) else {
                continue;
            };
            let Ok(checks) = merkur_traversal::check::Binding::install(
                socket.socket.clone(),
                keys.id,
                &keys.client,
                &keys.daemon,
                true,
                quota.clone(),
            ) else {
                continue;
            };
            self.authorities.push(checks.authority());
            self.checking.push(socket.id);
            let initial: Vec<SocketAddr> = offer
                .candidates
                .iter()
                .map(|candidate| SocketAddr::new(candidate.addr, candidate.port))
                .filter(|address| socket.routes(*address))
                .collect();
            let allowed = initial.clone();
            let routed = socket.clone();
            let responds = socket.clone();
            let (verified, mut received) = mpsc::channel(8);
            self.checks.0.push(tokio::spawn(checks.run(
                initial,
                move |address| {
                    routed.routes(address) && allowed.iter().any(|peer| peer.ip() == address.ip())
                },
                move |address| responds.routes(address),
                verified,
            )));
            let (events, network, binding, client_generation, manifest) = (
                self.events.clone(),
                self.network,
                socket.id,
                offer.client_generation,
                offer.generation,
            );
            self.checks.0.push(tokio::spawn(async move {
                while let Some(result) = received.recv().await {
                    let notice = match result {
                        merkur_traversal::check::Event::Verified(address) => Notice::Checked {
                            lineage,
                            network,
                            client_generation,
                            manifest,
                            binding,
                            address,
                        },
                        merkur_traversal::check::Event::Exhausted => Notice::Exhausted {
                            lineage,
                            network,
                            client_generation,
                            manifest,
                            binding,
                        },
                        merkur_traversal::check::Event::Checking => Notice::Checking {
                            lineage,
                            network,
                            client_generation,
                            manifest,
                            binding,
                        },
                    };
                    if events.send(notice).await.is_err() {
                        break;
                    }
                }
            }));
        }
    }

    pub fn binding(&self, id: u64) -> Option<Arc<SocketBinding>> {
        self.bindings
            .iter()
            .find(|(binding, _)| binding.id == id)
            .map(|(binding, _)| binding.clone())
    }

    fn clear_checks(&mut self) {
        for authority in self.authorities.drain(..) {
            authority.revoke();
        }
        self.checks.clear();
        self.checking.clear();
        self.finished.clear();
    }

    fn schedule_retry(&mut self, session: &Session) {
        let credential_retry = self.credential_failed || self.opening_failed;
        let checks_complete = self.observing.is_empty()
            && self.offered.is_some()
            && !self
                .authorities
                .iter()
                .any(|authority| authority.is_checking())
            && self
                .checking
                .iter()
                .all(|binding| self.finished.contains(binding));
        if self.credential.is_some()
            && (credential_retry || checks_complete)
            && !session.native_direct_live()
            && !session.native_direct_attempt_pending()
            && self.retry_at.is_none()
        {
            self.retry_at =
                Some(Instant::now() + session.native_discovery_retry_delay(self.failures));
        }
    }

    fn publish(&mut self, session: &mut Session, advance: bool) {
        let Some(lineage) = self.lineage else { return };
        if self.bindings.is_empty() {
            return;
        }
        self.clear_checks();
        self.offered = None;
        self.retry_at = None;
        if advance {
            self.generation = self
                .generation
                .checked_add(1)
                .expect("native candidate generation exhausted");
        }
        let mut bindings: Vec<Binding> = self
            .bindings
            .iter()
            .map(|(binding, _)| Binding {
                id: binding.id,
                family: binding.family,
                candidates: Vec::new(),
            })
            .collect();
        let mut remaining = merkur_wire::traversal::MAX_BINDINGS;
        // Give every family binding a slot before spending the remaining
        // resource budget on a second observation of any one binding.
        for index in 0..merkur_wire::traversal::MAX_BINDINGS {
            for (offered, (_, candidates)) in bindings.iter_mut().zip(&self.bindings) {
                if remaining > 0
                    && let Some(candidate) = candidates.get(index)
                {
                    offered.candidates.push(candidate.clone());
                    remaining -= 1;
                }
            }
        }
        session.publish_native_candidates(
            lineage,
            Snapshot {
                generation: self.generation,
                bindings,
                mac: String::new(),
            },
        );
    }

    pub fn apply(
        &mut self,
        notice: Notice,
        session: &mut Session,
        now_ms: u64,
    ) -> Option<AccountError> {
        if !self.notice_current(&notice) {
            return None;
        }
        match notice {
            Notice::Prepared {
                next_id,
                credential,
                credential_failed,
                bindings,
                ..
            } => {
                self.prepared(session, next_id, credential, credential_failed, bindings);
            }
            Notice::Checked {
                lineage,
                client_generation,
                manifest,
                binding,
                address,
                ..
            } => {
                tracing::debug!(
                    binding,
                    client_generation,
                    manifest,
                    stage = "check",
                    outcome = "verified"
                );
                session.native_pair_checked(
                    now_ms,
                    lineage,
                    client_generation,
                    manifest,
                    binding,
                    address,
                );
            }
            Notice::Observed {
                binding,
                gathered,
                complete,
                ..
            } => {
                self.observed(session, binding, gathered, complete)?;
            }
            Notice::Candidates {
                binding,
                candidates,
                ..
            } => {
                self.candidate_credential(&candidates)?;
                self.update_candidates(session, binding, candidates);
            }
            Notice::Expired { .. } => self.expire_discovery(),
            Notice::Exhausted {
                binding,
                client_generation,
                manifest,
                ..
            } => {
                tracing::debug!(
                    binding,
                    client_generation,
                    manifest,
                    stage = "check",
                    outcome = "exhausted"
                );
                if !self.finished.contains(&binding) {
                    self.finished.push(binding);
                }
            }
            Notice::Checking { binding, .. } => {
                self.finished.retain(|done| *done != binding);
                self.retry_at = None;
            }
            Notice::Retry { .. } => {
                self.retry_at = None;
                if !session.native_direct_live()
                    && !session.native_direct_attempt_pending()
                    && (self.credential_failed
                        || self.opening_failed
                        || !self
                            .authorities
                            .iter()
                            .any(|authority| authority.is_checking()))
                {
                    self.failures = self.failures.saturating_add(1);
                    self.requested = None;
                }
            }
            Notice::Denied { error, .. } => return Some(error),
        }
        None
    }

    fn notice_current(&self, notice: &Notice) -> bool {
        match notice {
            Notice::Prepared {
                lineage,
                network,
                work,
                ..
            }
            | Notice::Observed {
                lineage,
                network,
                work,
                ..
            }
            | Notice::Candidates {
                lineage,
                network,
                work,
                ..
            }
            | Notice::Denied {
                lineage,
                network,
                work,
                ..
            } => self.lineage == Some(*lineage) && self.network == *network && self.work == *work,
            Notice::Checked { binding, .. }
                if !self
                    .bindings
                    .iter()
                    .any(|(socket, _)| socket.id == *binding) =>
            {
                false
            }
            Notice::Checked {
                lineage,
                network,
                client_generation,
                manifest,
                ..
            }
            | Notice::Exhausted {
                lineage,
                network,
                client_generation,
                manifest,
                ..
            }
            | Notice::Checking {
                lineage,
                network,
                client_generation,
                manifest,
                ..
            } => {
                self.lineage == Some(*lineage)
                    && self.network == *network
                    && self.generation == *client_generation
                    && self.offered == Some((*client_generation, *manifest))
            }
            Notice::Expired {
                lineage,
                network,
                work,
                generation,
            }
            | Notice::Retry {
                lineage,
                network,
                work,
                generation,
            } => {
                self.lineage == Some(*lineage)
                    && self.network == *network
                    && self.work == *work
                    && self.generation == *generation
            }
        }
    }

    fn observed(
        &mut self,
        session: &mut Session,
        id: u64,
        gathered: socket::Gathered,
        complete: bool,
    ) -> Option<()> {
        let credential = self.candidate_credential(&gathered.candidates)?;
        let binding = self.binding(id)?;
        let candidates = gathered.candidates.clone();
        tracing::debug!(
            binding = id,
            candidates = candidates.len(),
            complete,
            stage = "observation",
            outcome = "completed"
        );
        if complete {
            self.observing.retain(|binding| *binding != id);
        }
        socket::commit_observations(&binding, gathered);
        if let Some(updates) = self.updates.clone()
            && let Some(worker) = socket::maintain(&binding, credential, updates)
        {
            self.register_worker(worker);
        }
        self.update_candidates(session, id, candidates);
        Some(())
    }

    fn prepared(
        &mut self,
        session: &mut Session,
        next_id: u64,
        credential: Arc<Credential>,
        credential_failed: bool,
        bindings: Vec<(Arc<SocketBinding>, Vec<Candidate>)>,
    ) {
        let Some(lineage) = self.lineage else { return };
        let (network, work) = (self.network, self.work);
        tracing::debug!(
            lineage,
            network,
            work,
            bindings = bindings.len(),
            credential_failed,
            stage = "gather",
            outcome = "prepared"
        );
        self.next_id = next_id;
        self.bindings = bindings;
        self.opening_failed = self.bindings.is_empty();
        self.observing = self
            .bindings
            .iter()
            .map(|(binding, _)| binding.id)
            .collect();
        self.credential_deadline =
            (!credential.servers.is_empty()).then_some(credential.expires_at);
        self.credential = Some(credential.clone());
        self.credential_failed = credential_failed;
        let (updates, mut received) = mpsc::channel(merkur_wire::traversal::MAX_BINDINGS);
        self.updates = Some(updates);
        for (binding, _) in &self.bindings {
            let (binding, credential, events) =
                (binding.clone(), credential.clone(), self.events.clone());
            self.gather.0.push(tokio::spawn(async move {
                socket::gather(&binding, &credential, |gathered, complete| {
                    let events = events.clone();
                    let id = binding.id;
                    async move {
                        let _delivery = events
                            .send(Notice::Observed {
                                lineage,
                                network,
                                work,
                                binding: id,
                                gathered,
                                complete,
                            })
                            .await;
                    }
                })
                .await;
            }));
        }
        let events = self.events.clone();
        self.gather.0.push(tokio::spawn(async move {
            while let Some((binding, candidates)) = received.recv().await {
                if events
                    .send(Notice::Candidates {
                        lineage,
                        network,
                        work,
                        binding,
                        candidates,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }));
        self.publish(session, false);
    }

    pub async fn next(&mut self) -> Notice {
        tokio::select! {
            biased;
            () = wait_deadline(self.credential_deadline) => Notice::Expired {
                lineage: self.lineage.unwrap_or(0), network: self.network,
                work: self.work, generation: self.generation,
            },
            Some(notice) = self.received.recv() => notice,
            () = wait_deadline(self.retry_at) => Notice::Retry {
                lineage: self.lineage.unwrap_or(0), network: self.network,
                work: self.work, generation: self.generation,
            },
        }
    }

    fn expire_discovery(&mut self) {
        tracing::debug!(
            generation = self.generation,
            work = self.work,
            stage = "credential",
            outcome = "expired"
        );
        self.clear_checks();
        self.gather.clear();
        self.work = self
            .work
            .checked_add(1)
            .expect("native discovery work generation exhausted");
        self.credential_deadline = None;
        self.credential_expired = true;
        self.credential = None;
        self.requested = None;
        self.offered = None;
        self.updates = None;
        self.observing.clear();
        self.retry_at = None;
    }

    fn candidate_credential(&mut self, candidates: &[Candidate]) -> Option<Arc<Credential>> {
        let credential = self.credential.clone()?;
        if candidates
            .iter()
            .any(|candidate| candidate.observation.ticket != credential.ticket)
        {
            return None;
        }
        if !credential.servers.is_empty() && credential.expires_at <= Instant::now() {
            self.expire_discovery();
            return None;
        }
        Some(credential)
    }

    fn update_candidates(&mut self, session: &mut Session, id: u64, candidates: Vec<Candidate>) {
        if let Some((_, held)) = self
            .bindings
            .iter_mut()
            .find(|(binding, _)| binding.id == id)
            && *held != candidates
        {
            *held = candidates;
            self.publish(session, true);
        }
    }
}

async fn wait_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        self.clear_checks();
        self.gather.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire_credential() -> serde_json::Value {
        let encoder = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        serde_json::json!({
            "ticket": encoder.encode([3; 41]),
            "secret": encoder.encode([7; 32]),
            "servers": ["203.0.113.1:3478", "203.0.113.2:3478"],
            "lifetimeMs": 90_000,
        })
    }

    #[tokio::test(start_paused = true)]
    async fn credentials_use_remaining_monotonic_validity_and_reject_bad_key_shapes() {
        let wire = wire_credential();
        let before = Instant::now();
        let credential = Credential::parse(&serde_json::to_vec(&wire).unwrap()).unwrap();
        assert_eq!(
            credential.expires_at,
            before + std::time::Duration::from_secs(90)
        );
        assert_eq!(credential.servers.len(), 2);
        for (field, value) in [
            ("secret", serde_json::json!("not-a-key")),
            ("ticket", serde_json::json!("not-a-ticket")),
            ("lifetimeMs", serde_json::json!(0)),
            ("lifetimeMs", serde_json::json!(900_001)),
            ("servers", serde_json::json!([])),
        ] {
            let mut bad = wire.clone();
            bad[field] = value;
            assert!(
                Credential::parse(&serde_json::to_vec(&bad).unwrap()).is_none(),
                "invalid {field}"
            );
        }
    }

    fn idle_session() -> Session {
        let certificate = serde_json::from_value(serde_json::json!({
            "userId": "owner", "rootKeyCommitment": "root", "delegationId": "delegate",
            "delegatePublicKey": "key", "scopes": ["terminal-session", "session-revoke"],
            "serverOrigin": "https://example.test", "rootEpoch": 1,
            "issuedAt": 1, "expiresAt": 100_000, "signature": "signature",
        }))
        .unwrap();
        Session::new(
            merkur_client::session::Config {
                browser_node_id: "client".into(),
                relay_only: false,
            },
            merkur_client::auth::Delegation {
                certificate,
                root_public_key: Box::new([0; merkur_authorization::PUBLIC_KEY_BYTES]),
                server_origin: "https://example.test".into(),
            },
        )
    }

    #[tokio::test]
    async fn stale_empty_maintenance_updates_cannot_withdraw_successor_candidates() {
        let mut credential = Credential::without_observers();
        credential.ticket = "current-ticket".into();
        credential.expires_at = Instant::now() + std::time::Duration::from_secs(90);
        let mut next = 1;
        let sockets = socket::open(Vec::new(), &mut next);
        let binding = sockets.into_iter().next().expect("owned loopback route");
        let candidate = Candidate {
            address: "198.51.100.1:50000".parse().unwrap(),
            kind: merkur_wire::signaling::CandidateKind::Srflx,
            observation: merkur_wire::traversal::Observation {
                ticket: credential.ticket.clone(),
                transaction: "transaction".into(),
                mapped: "198.51.100.1:50000".parse().unwrap(),
                observer: "203.0.113.1:3478".parse().unwrap(),
                receipt: "receipt".into(),
            },
        };
        let id = binding.id;
        let mut owner = Owner::new();
        owner.lineage = Some(1);
        owner.work = 2;
        owner.credential = Some(Arc::new(credential));
        owner.bindings = vec![(binding, vec![candidate.clone()])];
        let mut session = idle_session();
        owner.apply(
            Notice::Candidates {
                lineage: 1,
                network: 1,
                work: 1,
                binding: id,
                candidates: Vec::new(),
            },
            &mut session,
            0,
        );
        assert_eq!(owner.bindings[0].1, vec![candidate]);
        owner.apply(
            Notice::Candidates {
                lineage: 1,
                network: 1,
                work: 2,
                binding: id,
                candidates: Vec::new(),
            },
            &mut session,
            0,
        );
        assert!(
            owner.bindings[0].1.is_empty(),
            "current authoritative withdrawal is retained"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn completed_operations_request_a_fenced_retry_after_the_recovery_delay() {
        let mut owner = Owner::new();
        owner.lineage = Some(3);
        owner.work = 4;
        owner.requested = Some((3, 1));
        owner.credential = Some(Arc::new(Credential::without_observers()));
        owner.offered = Some((5, 6));
        owner.observing = vec![7];
        owner.checking = vec![7, 8];
        owner.finished = vec![7];
        let mut session = idle_session();
        owner.schedule_retry(&session);
        assert!(owner.retry_at.is_none(), "discovery is still running");
        owner.observing.clear();
        owner.schedule_retry(&session);
        assert!(owner.retry_at.is_none(), "one check queue is still running");
        owner.finished.push(8);
        owner.schedule_retry(&session);
        let due = owner.retry_at.expect("completed demand schedules recovery");
        assert!(due > Instant::now());
        tokio::time::advance(due - Instant::now()).await;
        let notice = owner.next().await;
        assert!(matches!(
            notice,
            Notice::Retry {
                lineage: 3,
                network: 1,
                work: 4,
                ..
            }
        ));
        owner.apply(notice, &mut session, 0);
        assert!(owner.requested.is_none());
        assert!(
            owner.retry_at.is_none(),
            "one deadline cannot become an idle refresh loop"
        );
        assert_eq!(owner.failures, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_completed_empty_binding_open_retries_without_waiting_for_an_offer() {
        let mut owner = Owner::new();
        owner.lineage = Some(1);
        owner.work = 2;
        owner.requested = Some((1, 1));
        let mut session = idle_session();
        owner.apply(
            Notice::Prepared {
                lineage: 1,
                network: 1,
                work: 2,
                next_id: 1,
                credential: Arc::new(Credential::without_observers()),
                credential_failed: false,
                bindings: Vec::new(),
            },
            &mut session,
            0,
        );
        assert!(owner.offered.is_none());
        owner.schedule_retry(&session);
        let due = owner
            .retry_at
            .expect("completed socket failure is retry demand");
        tokio::time::advance(due - Instant::now()).await;
        let notice = owner.next().await;
        owner.apply(notice, &mut session, 0);
        assert!(owner.requested.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_credential_request_can_retry_while_unproven_udp_checks_run() {
        let mut owner = Owner::new();
        owner.lineage = Some(1);
        owner.work = 2;
        owner.requested = Some((1, 1));
        owner.credential = Some(Arc::new(Credential::without_observers()));
        owner.credential_failed = true;
        owner.checking = vec![7];
        owner.observing = vec![7];
        let mut session = idle_session();
        owner.schedule_retry(&session);
        let due = owner
            .retry_at
            .expect("failed HTTP operation is independent retry demand");
        tokio::time::advance(due - Instant::now()).await;
        let notice = owner.next().await;
        owner.apply(notice, &mut session, 0);
        assert!(owner.requested.is_none());
    }

    struct NoRequests;
    impl Issuer for NoRequests {
        fn origin(&self) -> &str {
            "https://example.test"
        }
        fn issue(
            &self,
            _: merkur_client::issuance::IssuanceRequest,
        ) -> futures::future::BoxFuture<
            '_,
            Result<Box<merkur_client::issuance::Issuance>, AccountError>,
        > {
            unreachable!("closed session cannot issue")
        }
        fn renew(
            &self,
            _: merkur_client::issuance::RenewalRequest,
        ) -> futures::future::BoxFuture<
            '_,
            Result<merkur_client::issuance::RenewalCapability, AccountError>,
        > {
            unreachable!("closed session cannot renew")
        }
        fn stun(
            &self,
            _: merkur_client::issuance::StunCredentialRequest,
        ) -> futures::future::BoxFuture<'_, Result<Credential, AccountError>> {
            unreachable!("closed session cannot gather")
        }
    }

    fn checking_owner() -> (
        Owner,
        Arc<SocketBinding>,
        merkur_traversal::check::Authority,
    ) {
        let credential =
            Credential::parse(&serde_json::to_vec(&wire_credential()).unwrap()).unwrap();
        let mut next_id = 1;
        let held = socket::open(Vec::new(), &mut next_id)
            .into_iter()
            .next()
            .expect("owned family socket");
        let checks = merkur_traversal::check::Binding::install(
            held.socket.clone(),
            [1; 16],
            &[2; 32],
            &[3; 32],
            true,
            Arc::new(Semaphore::new(8)),
        )
        .unwrap();
        let authority = checks.authority();
        let mut owner = Owner::new();
        owner.lineage = Some(1);
        owner.work = 2;
        owner.generation = 3;
        owner.requested = Some((1, 1));
        owner.credential_deadline = Some(credential.expires_at);
        owner.credential = Some(Arc::new(credential));
        owner.bindings.push((held.clone(), Vec::new()));
        owner.authorities.push(authority.clone());
        let (events, received) = mpsc::channel(8);
        owner.checks.0.push(tokio::spawn(async move {
            let _received = received;
            checks.run(Vec::new(), |_| true, |_| true, events).await;
        }));
        (owner, held, authority)
    }

    #[tokio::test(start_paused = true)]
    async fn credential_deadline_revokes_checks_before_queued_results_and_retains_provider_socket()
    {
        let (mut owner, provider, authority) = checking_owner();
        let deadline = owner.credential_deadline.unwrap();
        assert!(
            owner
                .events
                .send(Notice::Checked {
                    lineage: 1,
                    network: 1,
                    client_generation: 3,
                    manifest: 4,
                    binding: provider.id,
                    address: "127.0.0.1:4443".parse().unwrap(),
                })
                .await
                .is_ok()
        );
        tokio::time::advance(deadline - Instant::now()).await;
        let notice = owner.next().await;
        assert!(
            matches!(notice, Notice::Expired { .. }),
            "deadline outranks queued check result"
        );
        let mut session = idle_session();
        owner.apply(notice, &mut session, 0);
        assert!(
            !authority.is_live(),
            "cold authority is revoked synchronously"
        );
        assert!(
            Arc::ptr_eq(&owner.binding(provider.id).unwrap(), &provider),
            "provider retains its socket and maintenance owner across grant expiry"
        );
        assert!(owner.credential_deadline.is_none());
        assert!(owner.checks.0.is_empty());
        assert!(
            owner.requested.is_none(),
            "unfulfilled direct demand may gather a fresh grant"
        );
    }

    #[tokio::test]
    async fn session_close_synchronously_revokes_checks_and_aborts_discovery_tasks() {
        let (mut owner, provider, authority) = checking_owner();
        let (held, mut released) = mpsc::channel::<()>(1);
        owner.gather.0.push(tokio::spawn(async move {
            let _held = held;
            std::future::pending::<()>().await;
        }));
        tokio::task::yield_now().await;
        let mut session = idle_session();
        session.handle(
            0,
            merkur_client::session::Event::AuthorizationDenied,
            &mut crate::driver::OsEntropy,
        );
        assert!(session.is_closed());
        let issuer: Arc<dyn Issuer> = Arc::new(NoRequests);
        owner.synchronize(&session, &issuer);
        assert!(!authority.is_live());
        assert!(owner.bindings.is_empty());
        assert!(owner.credential_deadline.is_none());
        assert!(owner.gather.0.is_empty() && owner.checks.0.is_empty());
        tokio::task::yield_now().await;
        assert!(
            released.recv().await.is_none(),
            "aborted task releases its owned sender"
        );
        assert_eq!(
            Arc::strong_count(&provider),
            1,
            "closed owner releases its socket ownership"
        );
    }
}
