//! Stable, routed UDP bindings. Mapping lifetime follows the last carrier owner.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures::{StreamExt, stream::FuturesUnordered};
use merkur_stun_protocol::observation::Receipt;
use merkur_traversal::{
    discovery_socket::DiscoverySocket,
    egress::{EgressPath, EgressPath6},
    portmap,
    stun::{self, StunCredential},
};
use merkur_wire::{
    signaling::CandidateKind,
    traversal::{Candidate, MAX_BINDINGS, Observation},
};
use ring::hmac;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio::time::{Duration, Instant};
use wtransport::quinn::{AsyncUdpSocket, UdpPoller, udp};
#[cfg(not(merkur_sim))]
use wtransport::quinn::{Runtime, TokioRuntime};
use wtransport::{ClientConfig, Endpoint, endpoint::endpoint_side::Client};

use super::Credential;

type CandidateUpdates = mpsc::Sender<(u64, Vec<Candidate>)>;

#[derive(Clone)]
struct MaintenanceInput {
    credential: Arc<Credential>,
    updates: CandidateUpdates,
    observation_generation: u64,
}

struct Maintenance {
    input: watch::Sender<MaintenanceInput>,
}

#[derive(Default)]
struct Observations {
    generation: u64,
    gathered: Gathered,
}

/// A gathering completion is committed only after its session owner validates
/// the exact lineage, network and work generation. Local metadata never crosses
/// the signaling boundary and never selects a data socket's route.
#[derive(Clone, Default)]
pub struct Gathered {
    pub candidates: Vec<Candidate>,
    paths: Vec<ObservedPath>,
    observers: Vec<SocketAddr>,
}

#[derive(Clone)]
struct ObservedPath {
    local: IpAddr,
    mapped: IpAddr,
    observer: SocketAddr,
}

/// Leave every actual send's source and interface selection to the kernel,
/// including QUIC replies whose receive metadata supplied a previous local IP.
struct NativeSocket {
    inner: Arc<dyn AsyncUdpSocket>,
    _allocation: OwnedSemaphorePermit,
}

#[derive(Debug)]
struct NativePoller {
    inner: Pin<Box<dyn UdpPoller>>,
    _socket: Arc<NativeSocket>,
}

impl UdpPoller for NativePoller {
    fn poll_writable(self: Pin<&mut Self>, cx: &mut Context) -> Poll<io::Result<()>> {
        self.get_mut().inner.as_mut().poll_writable(cx)
    }
}

impl std::fmt::Debug for NativeSocket {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeSocket")
            .finish_non_exhaustive()
    }
}

impl AsyncUdpSocket for NativeSocket {
    fn create_io_poller(self: Arc<Self>) -> Pin<Box<dyn UdpPoller>> {
        Box::pin(NativePoller {
            inner: self.inner.clone().create_io_poller(),
            _socket: self,
        })
    }

    fn try_send(&self, transmit: &udp::Transmit<'_>) -> io::Result<()> {
        self.inner.try_send(&udp::Transmit {
            destination: transmit.destination,
            ecn: transmit.ecn,
            contents: transmit.contents,
            segment_size: transmit.segment_size,
            src_ip: None,
        })
    }

    fn poll_recv(
        &self,
        context: &mut Context<'_>,
        bufs: &mut [io::IoSliceMut<'_>],
        meta: &mut [udp::RecvMeta],
    ) -> Poll<io::Result<usize>> {
        self.inner.poll_recv(context, bufs, meta)
    }
    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.local_addr()
    }
    fn max_transmit_segments(&self) -> usize {
        self.inner.max_transmit_segments()
    }
    fn max_receive_segments(&self) -> usize {
        self.inner.max_receive_segments()
    }
    fn may_fragment(&self) -> bool {
        self.inner.may_fragment()
    }
}

pub struct SocketBinding {
    pub id: u64,
    pub family: u8,
    pub local: SocketAddr,
    pub endpoint: Arc<Endpoint<Client>>,
    pub socket: Arc<DiscoverySocket>,
    observations: Arc<Mutex<Observations>>,
    maintenance: Mutex<Option<Maintenance>>,
    retired: Arc<AtomicBool>,
}

impl SocketBinding {
    /// Family support is the only preflight fact. The kernel applies its real
    /// UDP flow policy to every send; authenticated checks prove reachability.
    pub fn routes(&self, destination: SocketAddr) -> bool {
        !self.is_retired() && (self.family == 4) == destination.is_ipv4()
    }

    pub fn is_retired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }
}

/// One stable wildcard port per family, independent of observer availability.
/// An unavailable IPv6 stack simply cannot create that family's binding.
pub struct Opened {
    pub bindings: Vec<Arc<SocketBinding>>,
    pub capacity_blocked: bool,
}

pub fn open(
    mut existing: Vec<Arc<SocketBinding>>,
    next_id: &mut u64,
    budget: &Arc<Semaphore>,
) -> Opened {
    existing.retain(|binding| !binding.is_retired());
    let mut capacity_blocked = false;
    for family in [4, 6] {
        if existing.iter().any(|binding| binding.family == family) {
            continue;
        }
        let Some(id) = next_id
            .checked_add(1)
            .filter(|id| *id <= 9_007_199_254_740_991)
        else {
            break;
        };
        let Ok(allocation) = budget.clone().try_acquire_owned() else {
            capacity_blocked = true;
            break;
        };
        if let Ok(binding) = create(id, family, allocation) {
            *next_id = id;
            existing.push(Arc::new(binding));
        }
    }
    Opened {
        bindings: existing,
        capacity_blocked,
    }
}

#[cfg(test)]
fn test_binding(id: u64, family: u8) -> io::Result<SocketBinding> {
    let allocation = Arc::new(Semaphore::new(MAX_BINDINGS))
        .try_acquire_owned()
        .map_err(|error| io::Error::other(error.to_string()))?;
    create(id, family, allocation)
}

fn create(id: u64, family: u8, allocation: OwnedSemaphorePermit) -> io::Result<SocketBinding> {
    let address = if family == 4 {
        SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, 0))
    } else {
        SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, 0))
    };
    let config = ClientConfig::builder()
        .with_bind_default()
        // Each dial supplies its immutable pins; this endpoint authorizes nobody.
        .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new([0; 32])])
        .build();
    #[cfg(not(merkur_sim))]
    let (socket, runtime) = {
        let raw = socket2::Socket::new(
            socket2::Domain::for_address(address),
            socket2::Type::DGRAM,
            Some(socket2::Protocol::UDP),
        )?;
        if family == 6 {
            raw.set_only_v6(true)?;
        }
        raw.bind(&address.into())?;
        raw.set_nonblocking(true)?;
        let inner = TokioRuntime.wrap_udp_socket(raw.into())?;
        (
            DiscoverySocket::from_abstract(Arc::new(NativeSocket {
                inner,
                _allocation: allocation,
            })),
            Arc::new(TokioRuntime) as Arc<dyn wtransport::quinn::Runtime>,
        )
    };
    #[cfg(merkur_sim)]
    let (config, socket, runtime) = {
        let mut config = config;
        let bound = wtransport::endpoint::sim::bind(address)?;
        config
            .quic_endpoint_config_mut()
            .rng_seed(Some(bound.rng_seed));
        (
            config,
            DiscoverySocket::from_abstract(Arc::new(NativeSocket {
                inner: bound.socket,
                _allocation: allocation,
            })),
            bound.runtime,
        )
    };
    let local = socket.local_addr()?;
    let endpoint = Endpoint::client_with_socket(config, socket.clone(), runtime)?;
    Ok(SocketBinding {
        id,
        family,
        local,
        endpoint: Arc::new(endpoint),
        socket,
        observations: Arc::new(Mutex::new(Observations::default())),
        maintenance: Mutex::new(None),
        retired: Arc::new(AtomicBool::new(false)),
    })
}

fn discovery_credential(credential: &Credential) -> Option<StunCredential> {
    let secret =
        zeroize::Zeroizing::new(URL_SAFE_NO_PAD.decode(credential.secret.as_bytes()).ok()?);
    if secret.len() != 32 {
        return None;
    }
    Some(StunCredential {
        servers: Arc::new(credential.servers.clone()),
        ticket: Arc::new(credential.ticket.clone()),
        integrity_key: Arc::new(hmac::Key::new(hmac::HMAC_SHA256, &secret)),
        expires_at: credential.expires_at,
    })
}

pub async fn gather<F, Fut>(binding: &Arc<SocketBinding>, credential: &Credential, on_progress: F)
where
    F: FnMut(Gathered, bool) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    gather_on(&binding.socket, binding.family, credential, on_progress).await;
}

pub fn commit_observations(binding: &Arc<SocketBinding>, gathered: Gathered) {
    if let Ok(mut stored) = binding.observations.lock() {
        stored.generation = stored
            .generation
            .checked_add(1)
            .expect("observation ownership generation exhausted");
        stored.gathered = gathered;
    }
}

async fn gather_on<F, Fut>(
    socket: &Arc<DiscoverySocket>,
    family: u8,
    credential: &Credential,
    mut on_progress: F,
) -> Gathered
where
    F: FnMut(Gathered, bool) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let Some(discovery) =
        discovery_credential(credential).filter(|_| credential.expires_at > Instant::now())
    else {
        on_progress(Gathered::default(), true).await;
        return Gathered::default();
    };
    let mut pending = FuturesUnordered::new();
    let mut requested = Vec::new();
    for server in credential.servers.iter().take(8) {
        if requested.contains(&server.as_str()) {
            continue;
        }
        requested.push(server.as_str());
        let discovery = &discovery;
        // Resolve each observer inside its own worker. A slow resolver or a
        // silent observer cannot delay another worker's authenticated result.
        pending.push(async move {
            let destination = stun::resolve_observer_for(server, family == 4)
                .await
                .ok_or_else(|| "observer has no address in this binding's family".to_owned())?;
            stun::observe(socket, discovery, destination).await
        });
    }
    let mut gathered = Gathered::default();
    if pending.is_empty() {
        on_progress(gathered.clone(), true).await;
    }
    while let Some(result) = pending.next().await {
        let Ok(observed) = result else {
            on_progress(gathered.clone(), pending.is_empty()).await;
            continue;
        };
        if stun::observed_inside_nat_realm(observed.mapped.ip()) {
            on_progress(gathered.clone(), pending.is_empty()).await;
            continue;
        }
        if !gathered.observers.contains(&observed.observer) {
            gathered.observers.push(observed.observer);
        }
        if let Some(local) = observed.local_ip.filter(|ip| !ip.is_unspecified()) {
            // Keep each actual path even when two observers report the same
            // external endpoint: its preservation traffic has a real destination.
            if !gathered
                .paths
                .iter()
                .any(|path| path.local == local && path.observer == observed.observer)
            {
                gathered.paths.push(ObservedPath {
                    local,
                    mapped: observed.mapped.ip(),
                    observer: observed.observer,
                });
            }
        }
        if gathered
            .candidates
            .iter()
            .any(|candidate| candidate.address == observed.mapped)
        {
            on_progress(gathered.clone(), pending.is_empty()).await;
            continue;
        }
        let Receipt { observer, tag } = observed.receipt;
        gathered.candidates.push(Candidate {
            address: observed.mapped,
            kind: if family == 6
                && observed.local_ip == Some(observed.mapped.ip())
                && socket
                    .local_addr()
                    .is_ok_and(|local| local.port() == observed.mapped.port())
            {
                CandidateKind::Host6
            } else {
                CandidateKind::Srflx
            },
            observation: Observation {
                ticket: credential.ticket.clone(),
                transaction: URL_SAFE_NO_PAD.encode(observed.transaction),
                mapped: observed.mapped,
                observer,
                receipt: URL_SAFE_NO_PAD.encode(tag),
            },
        });
        on_progress(gathered.clone(), pending.is_empty()).await;
    }
    gathered
}

/// A router-control path is derived only from actual received packet metadata
/// and an unambiguous owning interface. It never constrains data socket sends.
#[derive(Clone, PartialEq, Eq)]
struct RouterPath {
    local: IpAddr,
    egress: Option<EgressPath>,
    egress6: Option<EgressPath6>,
}

fn router_path(local: IpAddr) -> Option<RouterPath> {
    if local.is_loopback() || local.is_unspecified() || local.is_multicast() {
        return None;
    }
    #[cfg(merkur_sim)]
    {
        let _ = local;
        None
    }
    #[cfg(not(merkur_sim))]
    {
        let interfaces = netdev::get_interfaces();
        let mut owners = interfaces.iter().filter(|interface| {
            interface
                .ipv4
                .iter()
                .any(|net| IpAddr::V4(net.addr()) == local)
                || interface
                    .ipv6
                    .iter()
                    .any(|net| IpAddr::V6(net.addr()) == local)
        });
        let interface = owners.next()?;
        if owners.next().is_some() {
            return None;
        }
        let (egress, egress6) = match local {
            IpAddr::V4(local_ipv4) => (
                Some(EgressPath {
                    local_ipv4,
                    interface_index: interface.index,
                    interface_name: interface.name.clone(),
                    gateway: interface
                        .gateway
                        .as_ref()
                        .and_then(|gateway| gateway.ipv4.first().copied()),
                }),
                None,
            ),
            IpAddr::V6(local) => (
                None,
                Some(EgressPath6 {
                    local,
                    interface_index: interface.index,
                    interface_name: interface.name.clone(),
                    gateway: interface
                        .gateway
                        .as_ref()
                        .and_then(|gateway| gateway.ipv6.first().copied()),
                }),
            ),
        };
        Some(RouterPath {
            local,
            egress,
            egress6,
        })
    }
}

struct Mapping {
    path: RouterPath,
    lease: Option<Box<portmap::Lease>>,
    pinhole: Option<Box<portmap::Pinhole>>,
    announcements: Option<Arc<tokio::net::UdpSocket>>,
    renewal: Option<Instant>,
}

impl Mapping {
    fn schedule(&mut self) {
        self.renewal = self
            .lease
            .as_ref()
            .map(|lease| lease.renew_after())
            .into_iter()
            .chain(self.pinhole.as_ref().map(|pinhole| pinhole.renew_after()))
            .min()
            .map(|delay| Instant::now() + delay);
    }
    async fn release(mut self) -> Result<(), Box<Self>> {
        if let Some(lease) = self.lease.as_ref()
            && portmap::release((**lease).clone()).await
        {
            self.lease = None;
        }
        if let Some(pinhole) = self.pinhole.as_ref()
            && portmap::release_pinhole((**pinhole).clone()).await
        {
            self.pinhole = None;
        }
        if self.lease.is_none() && self.pinhole.is_none() {
            Ok(())
        } else {
            Err(Box::new(self))
        }
    }
}

async fn acquire(path: RouterPath, observed: ObservedPath, port: u16) -> Mapping {
    let mut mapping = Mapping {
        path,
        lease: None,
        pinhole: None,
        announcements: None,
        renewal: None,
    };
    if observed.local.is_ipv4()
        && let portmap::Outcome::Mapped(lease) =
            portmap::acquire(port, mapping.path.egress.as_ref(), Some(observed.mapped)).await
    {
        mapping.announcements = mapping
            .path
            .egress
            .as_ref()
            .and_then(|path| portmap::announce::bind(path.local_ipv4).ok())
            .map(Arc::new);
        mapping.lease = Some(lease);
    }
    if observed.local.is_ipv6()
        && observed.local == observed.mapped
        && let portmap::PinholeOutcome::Pinholed(pinhole) =
            portmap::acquire_pinhole(port, mapping.path.egress6.as_ref()).await
    {
        mapping.pinhole = Some(pinhole);
    }
    mapping.schedule();
    mapping
}

#[derive(Clone, Copy)]
pub struct Retirement {
    pub binding: u64,
}

pub struct Quarantine {
    _socket: Arc<DiscoverySocket>,
    _grants: Vec<Mapping>,
}

impl Quarantine {
    pub(super) fn count(&self) -> usize {
        self._grants.len()
    }
}

pub type WorkerTask = tokio::task::JoinHandle<Option<Quarantine>>;

/// The worker captures the socket, never its binding. Last-carrier drop closes
/// its input; deletion completes before the internal UDP port can be reused.
/// A new worker returns its task to the session owner for the shutdown drain.
pub fn maintain(
    binding: &Arc<SocketBinding>,
    credential: Arc<Credential>,
    updates: CandidateUpdates,
    retirements: mpsc::Sender<Retirement>,
) -> Option<WorkerTask> {
    let Ok(mut owner) = binding.maintenance.lock() else {
        return None;
    };
    let observation_generation = binding
        .observations
        .lock()
        .map(|stored| stored.generation)
        .unwrap_or_default();
    let input = MaintenanceInput {
        credential,
        updates,
        observation_generation,
    };
    if let Some(maintenance) = owner.as_ref() {
        let old = maintenance.input.borrow();
        if old.credential.ticket == input.credential.ticket
            && old.updates.same_channel(&input.updates)
            && old.observation_generation == observation_generation
        {
            return None;
        }
        drop(old);
        maintenance.input.send_replace(input);
        return None;
    }
    let (sender, receiver) = watch::channel(input);
    *owner = Some(Maintenance { input: sender });
    let worker = Worker {
        id: binding.id,
        family: binding.family,
        port: binding.local.port(),
        socket: binding.socket.clone(),
        observations: binding.observations.clone(),
        mappings: Vec::new(),
        retired: binding.retired.clone(),
        retirements,
    };
    Some(tokio::spawn(worker.run(receiver)))
}

struct Worker {
    id: u64,
    family: u8,
    port: u16,
    socket: Arc<DiscoverySocket>,
    observations: Arc<Mutex<Observations>>,
    mappings: Vec<Mapping>,
    retired: Arc<AtomicBool>,
    retirements: mpsc::Sender<Retirement>,
}

struct Round {
    current: MaintenanceInput,
    generation: u64,
    gathered: Gathered,
}

enum Wake {
    Credentials,
    Renew,
    Announce(usize),
    Keepalive,
    Closed,
}

impl Worker {
    async fn run(mut self, mut input: watch::Receiver<MaintenanceInput>) -> Option<Quarantine> {
        let mut acquire_paths = true;
        let mut keepalive = None;
        let mut keepalive_targets = Vec::new();
        loop {
            let current = input.borrow_and_update().clone();
            if input.has_changed().is_err() {
                break;
            }
            let (generation, gathered) = self
                .observations
                .lock()
                .map(|value| (value.generation, value.gathered.clone()))
                .unwrap_or_default();
            let round = Round {
                current,
                generation,
                gathered,
            };
            if acquire_paths {
                acquire_paths = false;
                keepalive_targets = round.gathered.observers.clone();
                keepalive_targets.sort_unstable();
                keepalive_targets.dedup();
                // Progressive evidence must not repeatedly postpone an existing
                // path's preservation deadline while slower observers finish.
                keepalive = (!keepalive_targets.is_empty())
                    .then(|| keepalive.unwrap_or_else(|| Instant::now() + Duration::from_secs(14)));
                self.add_paths(&round, &input).await;
            }
            match next_wake(&mut self.mappings, &mut input, keepalive).await {
                Wake::Closed => break,
                Wake::Credentials => {
                    // Retry unsupported control contexts only after new evidence.
                    self.mappings
                        .retain(|mapping| mapping.lease.is_some() || mapping.pinhole.is_some());
                    acquire_paths = true;
                }
                Wake::Announce(index) => {
                    self.lost_path(index, &round, &input).await;
                    acquire_paths = true;
                }
                Wake::Renew => {
                    if renew_paths(&mut self.mappings).await
                        && !self.retired.swap(true, Ordering::AcqRel)
                    {
                        let _delivery =
                            self.retirements.send(Retirement { binding: self.id }).await;
                    }
                    publish(
                        self.id,
                        &round.current,
                        &round.gathered.candidates,
                        &self.mappings,
                        &input,
                    )
                    .await;
                }
                Wake::Keepalive => {
                    keepalive = Some(Instant::now() + Duration::from_secs(14));
                    for destination in &keepalive_targets {
                        let mut lifetime = input.clone();
                        tokio::select! {
                            result = self.socket.send(*destination, &[0]) => drop(result),
                            _ = lifetime.changed() => break,
                        }
                    }
                }
            }
        }
        // Deletion completes before the socket is dropped, so the internal
        // port cannot be reused by a replacement while old deletion is in flight.
        let mut releasing = FuturesUnordered::new();
        for mapping in self.mappings {
            releasing.push(mapping.release());
        }
        let mut unresolved = Vec::new();
        while let Some(result) = releasing.next().await {
            if let Err(mapping) = result {
                unresolved.push(*mapping);
            }
        }
        if unresolved.is_empty() {
            None
        } else {
            Some(Quarantine {
                _socket: self.socket,
                _grants: unresolved,
            })
        }
    }

    fn owns(&self, local: IpAddr) -> bool {
        self.mappings
            .iter()
            .any(|mapping| mapping.path.local.to_canonical() == local.to_canonical())
    }

    async fn add_paths(&mut self, round: &Round, input: &watch::Receiver<MaintenanceInput>) {
        let paths = round
            .gathered
            .paths
            .iter()
            .filter(|observed| !self.owns(observed.local))
            .filter_map(|observed| router_path(observed.local).map(|path| (path, observed.clone())))
            .collect();
        self.admit_paths(paths, round, input).await;
    }

    async fn admit_paths(
        &mut self,
        paths: Vec<(RouterPath, ObservedPath)>,
        round: &Round,
        input: &watch::Receiver<MaintenanceInput>,
    ) {
        if self.retired.load(Ordering::Acquire) {
            return;
        }
        let mut pending = FuturesUnordered::new();
        let mut acquiring = Vec::new();
        for (path, observed) in paths {
            if self.mappings.len() + pending.len() >= MAX_BINDINGS {
                break;
            }
            let local = observed.local.to_canonical();
            // Every allocation on this worker owns the same UDP port. Gateway
            // and outer-address changes do not create an independent tuple.
            if self.owns(local) || acquiring.contains(&local) {
                continue;
            }
            acquiring.push(local);
            pending.push(acquire(path, observed, self.port));
        }
        while let Some(mapping) = pending.next().await {
            self.mappings.push(mapping);
            // Publish each acquisition without waiting for another router.
            publish(
                self.id,
                &round.current,
                &round.gathered.candidates,
                &self.mappings,
                input,
            )
            .await;
        }
        publish(
            self.id,
            &round.current,
            &round.gathered.candidates,
            &self.mappings,
            input,
        )
        .await;
    }

    async fn lost_path(
        &mut self,
        index: usize,
        round: &Round,
        input: &watch::Receiver<MaintenanceInput>,
    ) {
        let lost_local = self.mappings[index].path.local;
        // next_wake matched this reset's gateway source and older epoch.
        // The old allocation is already gone; a delayed Delete could erase its successor.
        self.mappings.remove(index);
        let unaffected: Vec<_> =
            round
                .gathered
                .candidates
                .iter()
                .filter(|candidate| {
                    !round.gathered.paths.iter().any(|path| {
                        path.local == lost_local && path.mapped == candidate.address.ip()
                    }) || round.gathered.paths.iter().any(|path| {
                        path.local != lost_local && path.mapped == candidate.address.ip()
                    })
                })
                .cloned()
                .collect();
        publish(self.id, &round.current, &unaffected, &self.mappings, input).await;
        self.refresh(&self.mappings, round, input).await;
    }

    async fn refresh(
        &self,
        mappings: &[Mapping],
        round: &Round,
        input: &watch::Receiver<MaintenanceInput>,
    ) {
        let mut generation = round.generation;
        // Each transaction completion updates the cache only while this exact
        // generation still owns it, then publishes promptly through that same
        // ownership-fenced sink. A slow observer never delays healthy evidence.
        gather_on(
            &self.socket,
            self.family,
            &round.current.credential,
            |gathered, _complete| {
                let accepted = if input.has_changed().is_ok()
                    && input.borrow().credential.ticket == round.current.credential.ticket
                    && let Ok(mut stored) = self.observations.lock()
                    && stored.generation == generation
                {
                    generation = generation
                        .checked_add(1)
                        .expect("observation ownership generation exhausted");
                    stored.generation = generation;
                    stored.gathered = gathered.clone();
                    true
                } else {
                    false
                };
                async move {
                    if accepted {
                        publish(
                            self.id,
                            &round.current,
                            &gathered.candidates,
                            mappings,
                            input,
                        )
                        .await;
                    }
                }
            },
        )
        .await;
    }
}

async fn next_wake(
    mappings: &mut [Mapping],
    input: &mut watch::Receiver<MaintenanceInput>,
    keepalive: Option<Instant>,
) -> Wake {
    loop {
        let renewal = mappings.iter().filter_map(|mapping| mapping.renewal).min();
        let mut announcements = FuturesUnordered::new();
        for (index, mapping) in mappings.iter().enumerate() {
            if let Some(listener) = mapping.announcements.as_ref() {
                let listener = listener.clone();
                announcements.push(async move {
                    let mut packet = [0; portmap::announce::MAX_ANNOUNCEMENT_LEN];
                    (
                        index,
                        listener
                            .recv_from(&mut packet)
                            .await
                            .map(|(len, from)| (from, portmap::announce::decode(&packet[..len]))),
                    )
                });
            }
        }
        tokio::select! {
            changed = input.changed() => return if changed.is_ok() { Wake::Credentials } else { Wake::Closed },
            () = wait_until(renewal) => return Wake::Renew,
            result = async { if announcements.is_empty() { std::future::pending().await } else { announcements.next().await } } => {
                let Some((index, result)) = result else { continue; };
                match result {
                    Ok((from, Some(announcement))) if mappings[index].lease.as_ref().is_some_and(|lease| from.ip() == IpAddr::V4(lease.gateway) && lease.lost_to(&announcement)) => return Wake::Announce(index),
                    Err(_) => mappings[index].announcements = None,
                    _ => {},
                }
            },
            () = wait_until(keepalive) => return Wake::Keepalive,
        }
    }
}

async fn renew_paths(mappings: &mut [Mapping]) -> bool {
    let mut failed = false;
    for mapping in mappings.iter_mut() {
        if mapping
            .renewal
            .is_none_or(|deadline| deadline > Instant::now())
        {
            continue;
        }
        let lease_ok = match mapping.lease.as_mut() {
            Some(lease) => portmap::renew(lease).await,
            None => true,
        };
        let pinhole_ok = match mapping.pinhole.as_mut() {
            Some(pinhole) => portmap::renew_pinhole(pinhole).await,
            None => true,
        };
        if lease_ok && pinhole_ok {
            mapping.schedule();
        } else {
            mapping.renewal = None;
            failed = true;
        }
    }
    failed
}

async fn publish(
    id: u64,
    input: &MaintenanceInput,
    base: &[Candidate],
    mappings: &[Mapping],
    lifetime: &watch::Receiver<MaintenanceInput>,
) {
    let mut candidates = base.to_vec();
    for mapping in mappings {
        if let Some(lease) = mapping.lease.as_ref()
            && lease.expires_at > std::time::Instant::now()
            && let Some(proof) = base
                .iter()
                .find(|candidate| candidate.address.ip() == lease.external.ip())
        {
            candidates.retain(|candidate| candidate.address != lease.external);
            candidates.insert(
                0,
                Candidate {
                    address: lease.external,
                    kind: CandidateKind::NatMap,
                    observation: proof.observation.clone(),
                },
            );
        }
    }
    // A full old sink cannot hold a mapping/socket after its last owner drops.
    // Clone the receiver so cancellation does not consume the worker's update.
    let mut lifetime = lifetime.clone();
    if lifetime.has_changed().is_err() {
        return;
    }
    tokio::select! {
        _ = input.updates.send((id, candidates)) => {},
        _ = lifetime.changed() => {},
    }
}

async fn wait_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

#[cfg(all(test, not(merkur_sim)))]
mod tests {
    use super::*;
    use crate::carrier::{Carrier, InboundSender};
    use merkur_client::session::ConnId;
    use wtransport::endpoint::endpoint_side::Server;

    #[tokio::test]
    async fn physical_socket_capacity_survives_its_last_handle_until_the_io_poller_drops() {
        let budget = Arc::new(Semaphore::new(1));
        let raw = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
        let address = raw.local_addr().unwrap();
        raw.set_nonblocking(true).unwrap();
        let socket = Arc::new(NativeSocket {
            inner: TokioRuntime.wrap_udp_socket(raw).unwrap(),
            _allocation: budget.clone().try_acquire_owned().unwrap(),
        });
        let poller = socket.clone().create_io_poller();
        drop(socket);
        assert!(budget.clone().try_acquire_owned().is_err());
        assert_eq!(
            std::net::UdpSocket::bind(address).unwrap_err().kind(),
            io::ErrorKind::AddrInUse
        );
        drop(poller);
        assert!(budget.try_acquire_owned().is_ok());
        assert!(std::net::UdpSocket::bind(address).is_ok());
    }

    #[tokio::test]
    async fn wildcard_sends_clear_stale_source_hints_and_preserve_the_owned_port() {
        let receiving = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let raw = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
        raw.set_nonblocking(true).unwrap();
        let socket = Arc::new(NativeSocket {
            _allocation: Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap(),
            inner: TokioRuntime.wrap_udp_socket(raw).unwrap(),
        });
        assert!(socket.local_addr().unwrap().ip().is_unspecified());
        let transmit = udp::Transmit {
            destination: receiving.local_addr().unwrap(),
            ecn: None,
            contents: b"kernel selected route",
            segment_size: None,
            // This address is not owned by this machine. Forwarding it would
            // fail or override current policy; native sends must clear it.
            src_ip: Some("192.0.2.197".parse().unwrap()),
        };
        let mut writable = socket.clone().create_io_poller();
        std::future::poll_fn(|context| {
            loop {
                match socket.try_send(&transmit) {
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::task::ready!(writable.as_mut().poll_writable(context))?;
                    }
                    sent => return Poll::Ready(sent),
                }
            }
        })
        .await
        .unwrap();
        let mut packet = [0; 64];
        let (len, source) =
            tokio::time::timeout(Duration::from_secs(1), receiving.recv_from(&mut packet))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(&packet[..len], transmit.contents);
        assert_eq!(source.ip(), "127.0.0.1".parse::<IpAddr>().unwrap());
        assert_eq!(source.port(), socket.local_addr().unwrap().port());
    }

    #[tokio::test]
    async fn a_full_candidate_sink_cannot_retain_a_retired_binding_worker() {
        let (updates, _unread) = mpsc::channel(1);
        updates.send((1, Vec::new())).await.unwrap();
        let current = MaintenanceInput {
            credential: Arc::new(Credential::without_observers()),
            updates,
            observation_generation: 0,
        };
        let (owner, lifetime) = watch::channel(current.clone());
        let publishing = publish(1, &current, &[], &[], &lifetime);
        tokio::pin!(publishing);
        assert!(
            futures::poll!(publishing.as_mut()).is_pending(),
            "the bounded sink is deliberately full"
        );
        drop(owner);
        tokio::time::timeout(Duration::from_secs(1), publishing)
            .await
            .unwrap();
    }

    struct Peer {
        endpoint: Arc<Endpoint<Server>>,
        hash: [u8; 32],
        connections: mpsc::Receiver<wtransport::Connection>,
        accept: tokio::task::JoinHandle<()>,
    }

    impl Drop for Peer {
        fn drop(&mut self) {
            self.accept.abort();
        }
    }

    fn peer() -> Peer {
        let identity = wtransport::Identity::self_signed(["localhost", "127.0.0.1"]).unwrap();
        let hash = *identity.certificate_chain().as_slice()[0].hash().as_ref();
        let config = wtransport::ServerConfig::builder()
            .with_bind_address("127.0.0.1:0".parse().unwrap())
            .with_identity(identity)
            .build();
        let endpoint = Arc::new(Endpoint::server(config).unwrap());
        let accepting = endpoint.clone();
        let (send, connections) = mpsc::channel(4);
        let accept = tokio::spawn(async move {
            loop {
                let incoming = accepting.accept().await;
                // Failed pin validation ends one incoming handshake, not this
                // listener or another accepted connection.
                if let Ok(request) = incoming.await
                    && let Ok(connection) = request.accept().await
                    && send.send(connection).await.is_err()
                {
                    return;
                }
            }
        });
        Peer {
            endpoint,
            hash,
            connections,
            accept,
        }
    }

    async fn reject_wrong_pins(
        binding: &Arc<SocketBinding>,
        first_addr: SocketAddr,
        wrong_hash: [u8; 32],
        incoming: InboundSender,
    ) {
        let wrong = tokio::time::timeout(
            Duration::from_secs(5),
            Carrier::dial_direct(
                ConnId(3),
                binding.clone(),
                first_addr,
                wrong_hash,
                "https://localhost",
                incoming,
            ),
        )
        .await
        .unwrap();
        assert!(
            wrong.is_err(),
            "another concurrent dial's certificate cannot authorize this peer"
        );
        assert!(
            tokio::time::timeout(
                Duration::from_secs(5),
                binding.endpoint.connect(format!("https://{first_addr}"))
            )
            .await
            .unwrap()
            .is_err(),
            "connection-local pinning must leave the deny-all endpoint default intact"
        );
    }

    #[tokio::test]
    async fn shared_socket_preserves_per_dial_pins_and_losing_carrier_isolation() {
        drop(rustls::crypto::ring::default_provider().install_default());
        let (mut first, mut second) = (peer(), peer());
        let (first_addr, second_addr) = (
            first.endpoint.local_addr().unwrap(),
            second.endpoint.local_addr().unwrap(),
        );
        let credential = Credential::without_observers();
        let mut next_id = 0;
        let budget = Arc::new(Semaphore::new(MAX_BINDINGS));
        let mut bindings = open(Vec::new(), &mut next_id, &budget).bindings;
        assert!(bindings.iter().any(|binding| binding.family == 4));
        let binding = bindings.remove(
            bindings
                .iter()
                .position(|binding| binding.family == 4)
                .unwrap(),
        );
        let source = binding.local;
        assert!(
            gather_on(&binding.socket, binding.family, &credential, |_, _| {
                std::future::ready(())
            })
            .await
            .candidates
            .is_empty()
        );
        let reused = open(vec![binding.clone()], &mut next_id, &budget).bindings;
        assert!(Arc::ptr_eq(&reused[0], &binding));
        assert!(next_id <= 3);
        drop(reused);

        let (incoming, _receivers) = InboundSender::channel();
        let (winner, loser) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(
                Carrier::dial_direct(
                    ConnId(1),
                    binding.clone(),
                    first_addr,
                    first.hash,
                    "https://localhost",
                    incoming.clone()
                ),
                Carrier::dial_direct(
                    ConnId(2),
                    binding.clone(),
                    second_addr,
                    second.hash,
                    "https://localhost",
                    incoming.clone()
                ),
            )
        })
        .await
        .unwrap();
        let (winner, loser) = (winner.unwrap(), loser.unwrap());
        let remote_first = first.connections.recv().await.unwrap();
        let remote_second = second.connections.recv().await.unwrap();
        assert!(source.ip().is_unspecified());
        assert_eq!(remote_first.remote_address().port(), source.port());
        assert_eq!(remote_second.remote_address().port(), source.port());

        reject_wrong_pins(&binding, first_addr, second.hash, incoming).await;

        let owned = Arc::downgrade(&binding);
        drop(binding);
        drop(loser);
        assert!(
            owned.upgrade().is_some(),
            "the winning carrier retains the socket owner"
        );
        assert!(winner.send_datagram(b"winner still owns the exact checked socket"));
        let received =
            tokio::time::timeout(Duration::from_secs(5), remote_first.receive_datagram())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            received.payload().as_ref(),
            b"winner still owns the exact checked socket"
        );
        assert!(!remote_first.is_closed());
        let retained = owned.upgrade().unwrap();
        assert!(retained.routes(first_addr));
        assert!(retained.routes(second_addr));
        drop(retained);
        drop(winner);
        assert!(owned.upgrade().is_none());
    }

    #[tokio::test]
    async fn wildcard_observer_identity_is_evidence_not_a_keepalive_destination() {
        use merkur_stun_protocol::message::{self, ResponseWriter};
        drop(rustls::crypto::ring::default_provider().install_default());
        let responder = tokio::net::UdpSocket::bind("0.0.0.0:0").await.unwrap();
        let bound_identity = responder.local_addr().unwrap();
        let destination = SocketAddr::new("127.0.0.1".parse().unwrap(), bound_identity.port());
        let silent = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let raw_ticket = [3; 41];
        let requester_key = [7; 32];
        let credential = Arc::new(Credential {
            ticket: URL_SAFE_NO_PAD.encode(raw_ticket),
            secret: zeroize::Zeroizing::new(URL_SAFE_NO_PAD.encode(requester_key)),
            servers: vec![
                destination.to_string(),
                silent.local_addr().unwrap().to_string(),
            ],
            expires_at: Instant::now() + Duration::from_secs(90),
        });
        let serving = tokio::spawn(async move {
            let mut bytes = [0; 1200];
            let (len, peer) = responder.recv_from(&mut bytes).await.unwrap();
            let request = message::parse_binding_request(&bytes[..len]).unwrap();
            let key = hmac::Key::new(hmac::HMAC_SHA256, &requester_key);
            assert!(request.request_receipt);
            assert!(request.verify_integrity(&key));
            let mapped = "198.51.100.7:40000".parse().unwrap();
            let receipt_key = hmac::Key::new(hmac::HMAC_SHA256, &[9; 32]);
            let receipt = Receipt::issue(
                &receipt_key,
                &raw_ticket,
                request.transaction_id,
                mapped,
                bound_identity,
            );
            let mut response = ResponseWriter::new(request.transaction_id);
            assert!(response.push_address(
                message::ATTR_XOR_MAPPED_ADDRESS,
                mapped,
                request.transaction_id,
                true
            ));
            assert!(response.push_attribute(message::ATTR_OBSERVATION_RECEIPT, &receipt.encode()));
            assert!(response.finish_in_place(&key));
            responder.send_to(response.as_bytes(), peer).await.unwrap();
            let (len, preserved_from) = responder.recv_from(&mut bytes).await.unwrap();
            assert_eq!(&bytes[..len], &[0]);
            preserved_from
        });
        let binding = Arc::new(test_binding(1, 4).unwrap());
        let (progress, mut progressing) = mpsc::channel(2);
        let gathering_binding = binding.clone();
        let gathering_credential = credential.clone();
        let gathering = tokio::spawn(async move {
            gather(
                &gathering_binding,
                &gathering_credential,
                |gathered, complete| {
                    let progress = progress.clone();
                    async move {
                        drop(progress.send((gathered, complete)).await);
                    }
                },
            )
            .await;
        });
        let (gathered, complete) = tokio::time::timeout(Duration::from_secs(2), progressing.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            !complete,
            "a silent observer must not delay healthy receipt publication"
        );
        assert_eq!(gathered.candidates.len(), 1);
        gathering.abort();
        drop(gathering.await);
        assert_eq!(gathered.candidates[0].observation.observer, bound_identity);
        assert!(
            gathered.candidates[0]
                .observation
                .observer
                .ip()
                .is_unspecified()
        );
        commit_observations(&binding, gathered);
        let (updates, mut updated) = mpsc::channel(2);
        let (retirements, _retired) = mpsc::channel(MAX_BINDINGS);
        let maintaining = maintain(&binding, credential, updates, retirements).unwrap();
        updated.recv().await.unwrap();
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(15)).await;
        tokio::task::yield_now().await;
        tokio::time::resume();
        let source = tokio::time::timeout(Duration::from_secs(2), serving)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(source.port(), binding.local.port());
        assert!(binding.local.ip().is_unspecified());
        drop(binding);
        maintaining.await.unwrap();
    }
}

#[cfg(test)]
#[path = "socket/pinhole_tests.rs"]
pub(crate) mod pinhole_tests;
