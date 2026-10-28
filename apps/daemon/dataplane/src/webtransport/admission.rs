//! Connection-scoped router admission. Helpers never share a QUIC binding.
//!
//! A successful send publishes a candidate, never an admission verdict. Only
//! the ordinary session-key upgrade may adopt a connection. Preparation and
//! retirement run outside the terminal owner; established traffic uses the
//! existing source-owned channel senders without another dispatch layer.
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr, UdpSocket},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use futures::{FutureExt, StreamExt};
use tokio::{
    sync::{RwLock, mpsc, watch},
    task::JoinHandle,
};
use tracing::{info, warn};

#[path = "admission_sip.rs"]
mod sip;

use super::{
    CandidateFlavor, WebTransportServer, WebTransportState, discovery_socket::DiscoverySocket, stun,
};
use crate::{
    connection::{PeerDisplayState, PeerMap},
    network::{PeerEvent, peer::PeerMessage},
};

/// Resource bound: at most one preparation per authenticated peer, and 32
/// preparing/live cohorts per dataplane. Each cohort uses at most the manifest's
/// remaining candidate slots (10 overall), with one endpoint per mechanism/path.
const CAPACITY: usize = 32;
const MAX_COMPANIONS: usize =
    CAPACITY * merkur_wire::signaling::MAX_WEBTRANSPORT_OFFER_CANDIDATES / 2;
static NEXT_CLAIM: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct Identity {
    pub peer: Arc<str>,
    pub session: String,
    pub rebind: u64,
    pub manifest: u64,
    pub browser: IpAddr,
}

impl Identity {
    fn live(&self, peers: &PeerMap) -> bool {
        peers.get(&self.peer).is_some_and(|peer| self.matches(peer))
    }

    pub fn matches(&self, peer: &PeerDisplayState) -> bool {
        peer.authenticated
            && peer.is_e2e_ready()
            && peer.signal_session_id == self.session
            && peer.rebind.as_ref().map_or(0, |state| state.counter) == self.rebind
            && peer.manifest_generation == self.manifest
            && peer.browser_address.map(|address| address.to_canonical()) == Some(self.browser)
    }
}

/// A binding's identity is immutable. Cancellation may revoke preparation but
/// cannot revoke the session already authenticated on that exact connection.
pub struct Claim {
    pub id: u64,
    pub identity: Identity,
    live: AtomicBool,
    stable_connection: AtomicU64,
    connection_transition: Mutex<()>,
    authenticated: AtomicBool,
    epoch_owner: Arc<AtomicU64>,
    epoch: u64,
}

impl Claim {
    fn new(identity: Identity, epoch_owner: Arc<AtomicU64>, epoch: u64) -> Arc<Self> {
        Arc::new(Self {
            id: NEXT_CLAIM.fetch_add(1, Ordering::Relaxed),
            identity,
            epoch_owner,
            epoch,
            live: AtomicBool::new(true),
            stable_connection: AtomicU64::new(0),
            connection_transition: Mutex::new(()),
            authenticated: AtomicBool::new(false),
        })
    }

    pub fn accepts(&self, remote: IpAddr) -> bool {
        self.live.load(Ordering::Acquire)
            && self.epoch_owner.load(Ordering::Acquire) == self.epoch
            && remote.to_canonical() == self.identity.browser
    }

    #[must_use = "keep the guard alive until the native connection retires"]
    pub fn connected(&self, stable_id: usize) -> Option<ClaimConnection<'_>> {
        (self.live.load(Ordering::Acquire)
            && self
                .stable_connection
                .compare_exchange(0, stable_id as u64 + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok())
        .then(|| ClaimConnection {
            claim: self,
            stable_id,
        })
    }

    pub fn authorizes(&self, peer: &PeerDisplayState) -> bool {
        self.live.load(Ordering::Acquire)
            && self.epoch_owner.load(Ordering::Acquire) == self.epoch
            && self.identity.peer.as_ref() == peer.peer_id.as_ref()
            && self.identity.matches(peer)
    }

    pub(super) fn authenticate(&self, stable_id: usize) -> bool {
        let _transition = self.connection_transition.lock().unwrap();
        if !self.live.load(Ordering::Acquire)
            || self.epoch_owner.load(Ordering::Acquire) != self.epoch
            || self.stable_connection.load(Ordering::Acquire) != stable_id as u64 + 1
        {
            return false;
        }
        self.authenticated.store(true, Ordering::Release);
        true
    }

    fn owns(&self, peer: &PeerDisplayState) -> bool {
        self.authenticated.load(Ordering::Acquire)
            && peer
                .direct_session
                .as_ref()
                .and_then(|session| session.connection())
                .is_some_and(|conn| {
                    conn.quic_connection().stable_id() as u64 + 1
                        == self.stable_connection.load(Ordering::Acquire)
                })
    }
}

/// The exact native connection's unauthenticated reservation. Authentication
/// makes ownership permanent; every other supervisor exit releases only itself.
pub struct ClaimConnection<'a> {
    claim: &'a Claim,
    stable_id: usize,
}

impl Drop for ClaimConnection<'_> {
    fn drop(&mut self) {
        let _transition = self.claim.connection_transition.lock().unwrap();
        if !self.claim.authenticated.load(Ordering::Acquire)
            && self.claim.stable_connection.load(Ordering::Acquire) == self.stable_id as u64 + 1
        {
            // Connect only claims zero; this owner cannot change before this clear.
            self.claim.stable_connection.store(0, Ordering::Release);
        }
    }
}

pub struct Request {
    pub identity: Identity,
    pub state: Arc<RwLock<WebTransportState>>,
    pub config: wtransport::quinn::ServerConfig,
    pub credential: Option<stun::StunCredential>,
    /// The initial manifest is repeated with prepared candidates, under the
    /// same generation. Its existing candidates are never reclassified.
    pub manifest: serde_json::Value,
    pub epoch: u64,
    pub epoch_owner: Handle,
}

/// Queue preparation for the exact manifest being published. The listener
/// owner grants execution later after checking the same live session identity.
pub fn queue(
    wt: &Arc<RwLock<WebTransportState>>,
    snapshot: &WebTransportState,
    peer: &PeerDisplayState,
    manifest: &mut serde_json::Value,
) {
    let Some(browser) = peer.browser_address.map(|address| address.to_canonical()) else {
        return;
    };
    if let (Some(requests), Some(config)) =
        (&snapshot.admission_requests, &snapshot.admission_config)
        && super::side_channel::is_globally_routable(&browser)
        && (browser.is_ipv6() || snapshot.admission_credential.is_some())
        && !super::side_channel::punch_disabled()
        && peer.is_e2e_ready()
        && !peer.paths.webtransport.available
    {
        manifest["admission_pending"] = true.into();
        let queued = requests
            .try_send(Command::Prepare(Box::new(Request {
                identity: Identity {
                    peer: peer.peer_id.clone(),
                    session: peer.signal_session_id.clone(),
                    rebind: peer.rebind.as_ref().map_or(0, |state| state.counter),
                    manifest: peer.manifest_generation,
                    browser,
                },
                state: wt.clone(),
                config: config.clone(),
                credential: snapshot.admission_credential.clone(),
                manifest: manifest.clone(),
                epoch: requests.epoch(),
                epoch_owner: requests.clone(),
            })))
            .is_ok();
        if !queued {
            manifest["admission_pending"] = false.into();
        }
    }
}

pub enum Command {
    Prepare(Box<Request>),
    Reconcile,
}

#[derive(Clone)]
pub struct Handle {
    sender: mpsc::Sender<Command>,
    epoch: Arc<AtomicU64>,
    retirements: Retirement,
}
impl Handle {
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }
    pub fn try_send(&self, command: Command) -> Result<(), mpsc::error::TrySendError<Command>> {
        self.sender.try_send(command)
    }
}
pub fn channel() -> (Handle, mpsc::Receiver<Command>) {
    let (sender, receiver) = mpsc::channel(CAPACITY);
    (
        Handle {
            sender,
            epoch: Arc::new(AtomicU64::new(0)),
            retirements: Retirement::new(),
        },
        receiver,
    )
}

/// Tracks socket retirement independently of the terminal owner, including
/// cancellation of preparations before they publish a binding.
#[derive(Clone)]
struct Retirement {
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    stopping: watch::Sender<bool>,
    companions: Arc<Mutex<HashMap<CompanionKey, Arc<UdpSocket>>>>,
    gateways: Arc<Mutex<Option<super::router_grants::Owner>>>,
}

impl Retirement {
    fn new() -> Self {
        let (stopping, _) = watch::channel(false);
        Self {
            tasks: Arc::new(Mutex::new(Vec::new())),
            stopping,
            companions: Arc::new(Mutex::new(HashMap::new())),
            gateways: Arc::new(Mutex::new(None)),
        }
    }

    fn retire(
        &self,
        mut server: WebTransportServer,
        events: mpsc::Sender<PeerEvent>,
        sockets: (Option<Arc<UdpSocket>>, Option<UdpSocket>),
        media: Vec<sip::MediaOwner>,
    ) {
        let mut stopping = self.stopping.subscribe();
        let task = tokio::spawn(async move {
            let retired = server.shutdown().await;
            drop(media);
            drop(sockets);
            for retired in retired {
                if *stopping.borrow() {
                    break;
                }
                tokio::select! {
                    biased;
                    _ = stopping.changed() => break,
                    result = events.send(PeerEvent::Disconnected {
                        peer_id: retired.temp_peer_id,
                        connection_id: retired.connection_id,
                        reason: "direct-admission-retired".into(),
                    }) => { if result.is_err() { break; } }
                }
            }
        });
        self.track(task);
    }

    fn track(&self, task: JoinHandle<()>) {
        let mut tasks = self
            .tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        tasks.retain(|task| !task.is_finished());
        tasks.push(task);
    }

    async fn shutdown(&self) {
        self.stopping.send_replace(true);
        loop {
            let tasks = std::mem::take(
                &mut *self
                    .tasks
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            );
            if tasks.is_empty() {
                break;
            }
            for task in tasks {
                drop(task.await);
            }
        }
        let gateways = self
            .gateways
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(gateways) = gateways
            && let Err(error) = gateways.shutdown().await
        {
            warn!(%error, "direct admission gateway cleanup incomplete");
        }
    }
}

struct Binding {
    claim: Arc<Claim>,
    retirements: Retirement,
    server: Option<WebTransportServer>,
    events: mpsc::Sender<PeerEvent>,
    // RTP/RTCP helpers can admit both ports even when SDP requests only RTP.
    // Keep the unused companion bound exclusively and silent for this binding's
    // entire lifetime. The coordinator retains its reservation after retirement
    // so still-live helper state cannot expose a newly bound unrelated service.
    companion: Option<Arc<UdpSocket>>,
    signaling: Option<UdpSocket>,
    enhancement: Option<futures::future::BoxFuture<'static, Option<serde_json::Value>>>,
    media: sip::MediaSlot,
}

impl Drop for Binding {
    fn drop(&mut self) {
        self.claim.live.store(false, Ordering::Release);
        let media = self
            .media
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .unwrap_or_default();
        if let Some(server) = self.server.take() {
            self.retirements.retire(
                server,
                self.events.clone(),
                (self.companion.take(), self.signaling.take()),
                media,
            );
        }
    }
}

struct Prepared {
    bindings: Vec<Binding>,
    manifest: serde_json::Value,
}
struct Work {
    identity: Identity,
    epoch: u64,
    task: Option<JoinHandle<()>>,
    retirements: Retirement,
    bindings: Vec<Binding>,
}

impl Drop for Work {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            self.retirements.track(task);
        }
    }
}

/// This owner is advanced only by admission/session/network lifecycle events.
/// Neither terminal frames nor ACKs consult it.
pub struct Owner {
    adopted: Vec<Binding>,
    work: HashMap<Arc<str>, Work>,
    completed_tx: mpsc::Sender<(Identity, Prepared)>,
    completed_rx: mpsc::Receiver<(Identity, Prepared)>,
    messages: mpsc::Sender<PeerMessage>,
    events: mpsc::Sender<PeerEvent>,
    epoch: Arc<AtomicU64>,
    retirements: Retirement,
}

impl Owner {
    pub fn new(
        messages: mpsc::Sender<PeerMessage>,
        events: mpsc::Sender<PeerEvent>,
        handle: &Handle,
    ) -> Self {
        let (completed_tx, completed_rx) = mpsc::channel(CAPACITY);
        Self {
            adopted: Vec::new(),
            work: HashMap::new(),
            completed_tx,
            completed_rx,
            messages,
            events,
            epoch: handle.epoch.clone(),
            retirements: handle.retirements.clone(),
        }
    }

    pub fn command(&mut self, command: Command, peers: &PeerMap) -> Option<(Arc<str>, Vec<u8>)> {
        self.reconcile(peers);
        match command {
            Command::Prepare(request) => {
                let request = *request;
                if !request.identity.live(peers)
                    || request.epoch != self.epoch.load(Ordering::Acquire)
                    || peers.get(&request.identity.peer).is_some_and(|peer| {
                        peer.paths.webtransport.available
                            || peer.admission_done_generation == Some(request.identity.manifest)
                    })
                {
                    return None;
                }
                if !self.work.contains_key(&request.identity.peer)
                    && self.work.len() + self.adopted.len() >= CAPACITY
                {
                    let mut manifest = request.manifest;
                    manifest["admission_pending"] = false.into();
                    return Some((request.identity.peer, manifest.to_string().into_bytes()));
                }
                let epoch = request.epoch;
                let owner_identity = request.identity.clone();
                let completion = self.completed_tx.clone();
                let messages = self.messages.clone();
                let events = self.events.clone();
                let task = tokio::spawn(async move {
                    prepare(request, messages, events, completion).await;
                });
                self.work.insert(
                    owner_identity.peer.clone(),
                    Work {
                        identity: owner_identity,
                        epoch,
                        task: Some(task),
                        retirements: self.retirements.clone(),
                        bindings: Vec::new(),
                    },
                );
            }
            Command::Reconcile => {}
        }
        None
    }

    pub async fn ready(&mut self, peers: &PeerMap) -> Option<(Arc<str>, Vec<u8>)> {
        let (identity, prepared) = self.completed_rx.recv().await?;
        let work = self.work.get_mut(&identity.peer).filter(|work| {
            work.epoch == self.epoch.load(Ordering::Acquire)
                && work.identity.session == identity.session
                && work.identity.manifest == identity.manifest
                && identity.live(peers)
        })?;
        if peers.get(&identity.peer).is_some_and(|peer| {
            peer.paths.webtransport.available
                || peer.admission_done_generation == Some(identity.manifest)
        }) {
            return None;
        }
        work.bindings.extend(prepared.bindings);
        Some((identity.peer, prepared.manifest.to_string().into_bytes()))
    }

    pub fn reconcile(&mut self, peers: &PeerMap) {
        self.adopted.retain(|binding| {
            peers
                .get(&binding.claim.identity.peer)
                .is_some_and(|peer| binding.claim.owns(peer))
        });
        let adopted = &mut self.adopted;
        self.work.retain(|_, work| {
            let Some(peer) = peers.get(&work.identity.peer) else {
                return false;
            };
            let live =
                work.epoch == self.epoch.load(Ordering::Acquire) && work.identity.matches(peer);
            let preparing = live
                && !peer.paths.webtransport.available
                && peer.admission_done_generation != Some(work.identity.manifest);
            let mut pending = Vec::new();
            for binding in std::mem::take(&mut work.bindings) {
                if binding.claim.owns(peer) {
                    adopted.push(binding);
                } else if preparing {
                    pending.push(binding);
                }
            }
            work.bindings = pending;
            preparing
        });
    }

    pub fn invalidate(&mut self, peers: &PeerMap) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        self.reconcile(peers);
    }

    pub async fn shutdown(&mut self) {
        self.work.clear();
        self.adopted.clear();
        self.completed_rx.close();
        while self.completed_rx.try_recv().is_ok() {}
        self.retirements.shutdown().await;
    }
}

#[derive(Clone)]
struct Path {
    index: u32,
    name: String,
    address: IpAddr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct CompanionKey {
    interface: u32,
    local: SocketAddr,
}

impl Path {
    fn companion_key(&self, port: u16) -> CompanionKey {
        CompanionKey {
            interface: self.index,
            local: SocketAddr::from((self.address, port)),
        }
    }
}

fn paths(browser: IpAddr) -> Vec<Path> {
    #[cfg(merkur_sim)]
    {
        let _ = browser;
        Vec::new()
    }
    #[cfg(not(merkur_sim))]
    {
        let mut interfaces = netdev::get_interfaces();
        // A physical gateway-bearing interface precedes overlays. Every socket
        // is still bound explicitly: the default OS route is never substituted.
        interfaces.sort_by_key(|iface| (iface.gateway.is_none(), iface.index));
        interfaces
            .into_iter()
            .filter(|iface| iface.is_up() && !iface.is_loopback())
            .flat_map(|iface| {
                let addresses: Vec<IpAddr> = match browser {
                    IpAddr::V4(_) => iface
                        .ipv4
                        .iter()
                        .map(|net| net.addr())
                        .find(|ip| {
                            matches!(
                                super::classify_ipv4(ip),
                                super::AddressClass::Ipv4Private
                                    | super::AddressClass::Ipv4Global
                                    | super::AddressClass::Ipv4Cgnat
                            )
                        })
                        .map(IpAddr::V4)
                        .into_iter()
                        .collect(),
                    IpAddr::V6(_) => iface
                        .ipv6
                        .iter()
                        .map(|net| IpAddr::V6(net.addr()))
                        .filter(super::side_channel::is_globally_routable)
                        .collect(),
                };
                addresses.into_iter().map(move |address| Path {
                    index: iface.index,
                    name: iface.name.clone(),
                    address,
                })
            })
            .collect()
    }
}

fn bind(path: &Path, port: u16) -> std::io::Result<UdpSocket> {
    let socket = socket2::Socket::new(
        socket2::Domain::for_address(SocketAddr::from((path.address, port))),
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    if path.address.is_ipv6() {
        socket.set_only_v6(true)?;
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        use std::os::fd::AsRawFd;
        let (level, option) = match path.address {
            IpAddr::V4(_) => (libc::IPPROTO_IP, libc::IP_BOUND_IF),
            IpAddr::V6(_) => (libc::IPPROTO_IPV6, libc::IPV6_BOUND_IF),
        };
        // SAFETY: the live descriptor, pointer and length describe a u32
        // interface index. The bound-interface options select egress without changing routes.
        if unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                level,
                option,
                (&path.index as *const u32).cast(),
                libc::socklen_t::try_from(std::mem::size_of::<u32>())
                    .map_err(std::io::Error::other)?,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let index = path.index.to_be();
        let (level, option) = match path.address {
            IpAddr::V4(_) => (libc::IPPROTO_IP, libc::IP_UNICAST_IF),
            IpAddr::V6(_) => (libc::IPPROTO_IPV6, libc::IPV6_UNICAST_IF),
        };
        // SAFETY: the unicast-interface options take one network-order u32 index.
        // Unlike SO_BINDTODEVICE this does not require CAP_NET_RAW. Binding
        // the local address below also fixes the receive address/family.
        if unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                level,
                option,
                (&index as *const u32).cast(),
                libc::socklen_t::try_from(std::mem::size_of::<u32>())
                    .map_err(std::io::Error::other)?,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    socket.bind(&SocketAddr::from((path.address, port)).into())?;
    Ok(socket.into())
}

/// Reserve the complete even RTP/RTCP pair before any SIP packet leaves. Search
/// is local bind allocation only, never network traffic or guessed WAN ports.
fn pair(path: &Path, retirements: &Retirement) -> std::io::Result<(UdpSocket, Arc<UdpSocket>)> {
    let mut companions = retirements
        .companions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Reservations outlive individual candidates because router-side expiry is
    // not observable. At capacity, reuse only ports whose silent companion we
    // already own. No unrelated service can inherit that companion mid-process.
    if companions.len() == MAX_COMPANIONS {
        for (key, companion) in companions.iter() {
            if *key != path.companion_key(key.local.port()) {
                continue;
            }
            match bind(path, key.local.port() - 1) {
                Ok(media) => return Ok((media, companion.clone())),
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
                Err(error) => return Err(error),
            }
        }
    } else {
        // The OS allocates from its current ephemeral pool; a fixed starting
        // port would reuse still-live router state after every process restart.
        for _ in 0..8192 {
            let media = bind(path, 0)?;
            let port = media.local_addr()?.port();
            if !port.is_multiple_of(2) || port == u16::MAX {
                continue;
            }
            let key = path.companion_key(port + 1);
            if let Some(companion) = companions.get(&key) {
                return Ok((media, companion.clone()));
            }
            match reserve_companion(path, media) {
                Ok((media, companion)) => {
                    let companion = Arc::new(companion);
                    companions.insert(key, companion.clone());
                    return Ok((media, companion));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
                Err(error) => return Err(error),
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AddrNotAvailable,
        "no exclusive RTP/RTCP pair",
    ))
}

#[cfg(test)]
fn reserve_pair(path: &Path, port: u16) -> std::io::Result<(UdpSocket, UdpSocket)> {
    if port == 0 || !port.is_multiple_of(2) || port == u16::MAX {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "media port must own an even RTP/RTCP pair",
        ));
    }
    reserve_companion(path, bind(path, port)?)
}

fn reserve_companion(path: &Path, media: UdpSocket) -> std::io::Result<(UdpSocket, UdpSocket)> {
    let companion = bind(path, media.local_addr()?.port() + 1)?;
    Ok((media, companion))
}

fn tftp_request(nonce: &[u8; 16]) -> Vec<u8> {
    let name: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut bytes = b"\0\x01merkur-missing-".to_vec();
    bytes.extend_from_slice(name.as_bytes());
    bytes.extend_from_slice(b"\0octet\0");
    bytes
}

fn sip_request(
    path: &Path,
    signal_port: u16,
    media_port: u16,
    browser: IpAddr,
    nonce: &[u8; 16],
) -> Vec<u8> {
    merkur_traversal::sip::offer(
        SocketAddr::new(path.address, signal_port),
        SocketAddr::new(path.address, media_port),
        browser,
        nonce,
    )
}

enum Progress {
    Bound(Result<(Box<Binding>, serde_json::Value), String>),
    Observed {
        previous: serde_json::Value,
        candidate: Option<serde_json::Value>,
    },
}

async fn prepare(
    request: Request,
    messages: mpsc::Sender<PeerMessage>,
    events: mpsc::Sender<PeerEvent>,
    completion: mpsc::Sender<(Identity, Prepared)>,
) {
    let mut manifest = request.manifest.clone();
    let initial = manifest["candidates"].as_array().map_or(0, Vec::len);
    let room = merkur_wire::signaling::MAX_WEBTRANSPORT_OFFER_CANDIDATES.saturating_sub(initial);
    let browser = request.identity.browser;
    let paths = tokio::task::spawn_blocking(move || paths(browser))
        .await
        .unwrap_or_default();
    let mut preparations =
        futures::stream::FuturesUnordered::<futures::future::BoxFuture<'_, Progress>>::new();
    for path in paths.into_iter().take(room / 2) {
        for kind in [CandidateFlavor::Tftp, CandidateFlavor::Sip] {
            let request = &request;
            let path = path.clone();
            let messages = messages.clone();
            let events = events.clone();
            preparations.push(async move {
                let claim = Claim::new(request.identity.clone(), request.epoch_owner.epoch.clone(), request.epoch);
                let result = prepare_binding(&request.state, &request.config, request.credential.as_ref(), &path,
                    kind, claim, messages, events, request.epoch_owner.retirements.clone()).await;
                if let Err(error) = &result {
                    warn!(interface = path.name, ?kind, %error, "direct admission preparation refused");
                }
                Progress::Bound(result.map(|(binding, candidate)| (Box::new(binding), candidate)))
            }.boxed());
        }
    }
    if preparations.is_empty() {
        manifest["admission_pending"] = false.into();
        drop(
            completion
                .send((
                    request.identity.clone(),
                    Prepared {
                        bindings: Vec::new(),
                        manifest,
                    },
                ))
                .await,
        );
        return;
    }
    while let Some(progress) = preparations.next().await {
        let mut bindings = Vec::new();
        match progress {
            Progress::Bound(Ok((binding, candidate))) => {
                let mut binding = *binding;
                if let Some(enhancement) = binding.enhancement.take() {
                    let previous = candidate.clone();
                    preparations.push(
                        async move {
                            Progress::Observed {
                                previous,
                                candidate: enhancement.await,
                            }
                        }
                        .boxed(),
                    );
                }
                if let Some(candidates) = manifest["candidates"].as_array_mut() {
                    candidates.push(candidate);
                }
                bindings.push(binding);
            }
            Progress::Observed {
                previous,
                candidate: Some(candidate),
            } => {
                if let Some(candidates) = manifest["candidates"].as_array_mut()
                    && let Some(existing) = candidates.iter_mut().find(|value| **value == previous)
                {
                    *existing = candidate;
                }
            }
            Progress::Bound(Err(_))
            | Progress::Observed {
                candidate: None, ..
            } => {}
        }
        manifest["admission_pending"] = (!preparations.is_empty()).into();
        if completion
            .send((
                request.identity.clone(),
                Prepared {
                    bindings,
                    manifest: manifest.clone(),
                },
            ))
            .await
            .is_err()
        {
            return;
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "one preparation binds the socket, certificate, session claim and existing ingress owners"
)]
async fn prepare_binding(
    state: &Arc<RwLock<WebTransportState>>,
    config: &wtransport::quinn::ServerConfig,
    credential: Option<&stun::StunCredential>,
    path: &Path,
    kind: CandidateFlavor,
    claim: Arc<Claim>,
    messages: mpsc::Sender<PeerMessage>,
    events: mpsc::Sender<PeerEvent>,
    retirements: Retirement,
) -> Result<(Binding, serde_json::Value), String> {
    if path.address.is_ipv4() != claim.identity.browser.is_ipv4() {
        return Err("helper address families differ".into());
    }
    let path_for_bind = path.clone();
    let allocation_owner = retirements.clone();
    let (socket, companion, signaling) =
        tokio::task::spawn_blocking(move || -> std::io::Result<_> {
            match kind {
                CandidateFlavor::Tftp => Ok((bind(&path_for_bind, 0)?, None, None)),
                CandidateFlavor::Sip => {
                    let (media, companion) = pair(&path_for_bind, &allocation_owner)?;
                    Ok((media, Some(companion), Some(bind(&path_for_bind, 0)?)))
                }
                CandidateFlavor::Srflx
                | CandidateFlavor::NatMap
                | CandidateFlavor::Host4
                | CandidateFlavor::Host6
                | CandidateFlavor::Loopback => Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "candidate kind has no router admission request",
                )),
            }
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let port = socket.local_addr().map_err(|e| e.to_string())?.port();
    let discovery = DiscoverySocket::new(socket).map_err(|e| e.to_string())?;
    let config = wtransport::ServerConfig::builder()
        .with_bind_address(SocketAddr::from((path.address, port)))
        .build_with_quic_config(config.clone());
    let endpoint = wtransport::Endpoint::server_with_socket(config, discovery.clone())
        .map_err(|e| e.to_string())?;
    let server = WebTransportServer::spawn_claimed(
        endpoint,
        state.clone(),
        messages,
        events.clone(),
        Some(claim.clone()),
    );
    let mut binding = Binding {
        claim: claim.clone(),
        retirements,
        server: Some(server),
        events,
        companion,
        signaling,
        enhancement: None,
        media: Arc::new(Mutex::new(Some(Vec::new()))),
    };
    let observed =
        candidate_endpoint(&discovery, credential, kind == CandidateFlavor::Tftp).await?;
    let mut nonce = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce)
        .map_err(|error| format!("admission randomness unavailable: {error}"))?;
    if !claim.live.load(Ordering::Acquire)
        || claim.epoch_owner.load(Ordering::Acquire) != claim.epoch
    {
        return Err("admission generation retired".into());
    }
    let browser = claim.identity.browser;
    #[cfg(test)]
    router_tests::before_offer(port).await;
    let (bytes, candidate_port) = if kind == CandidateFlavor::Tftp {
        let bytes = tftp_request(&nonce);
        discovery
            .send(SocketAddr::from((browser, 69)), &bytes)
            .await
            .map_err(|e| e.to_string())?;
        (bytes, observed.port())
    } else {
        let bytes = sip::send(&mut binding, path, &discovery, observed, nonce).await?;
        // This is a requested endpoint, not an observed lease. A helper may
        // rewrite its address/port through collisions or multiple NAT layers.
        // No adjacent WAN port is guessed; authentication decides reachability.
        (bytes, port)
    };
    info!(claim = claim.id, interface = path.name, local = %path.address, port, ?kind, bytes = bytes.len(), "direct admission request sent; router acceptance unknown");
    Ok((
        binding,
        serde_json::json!({ "addr": observed.ip(), "port": candidate_port, "kind": kind, "scope": "public", "admission": 0 }),
    ))
}

async fn candidate_endpoint(
    socket: &Arc<DiscoverySocket>,
    credential: Option<&stun::StunCredential>,
    require_agreement: bool,
) -> Result<SocketAddr, String> {
    use wtransport::quinn::AsyncUdpSocket;
    let local = socket.local_addr().map_err(|error| error.to_string())?;
    if local.is_ipv6() {
        return Ok(local);
    }
    let observed = stun::admission_mapping(
        socket,
        credential.ok_or("missing IPv4 STUN credential")?,
        require_agreement,
    )
    .await?;
    if !super::side_channel::is_globally_routable(&observed.ip()) {
        return Err("observer is inside NAT realm".into());
    }
    Ok(observed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::PeerTransport;
    use std::net::Ipv4Addr;

    fn identity() -> Identity {
        Identity {
            peer: Arc::from("browser"),
            session: "session".into(),
            rebind: 0,
            manifest: 1,
            browser: "198.51.100.7".parse().unwrap(),
        }
    }

    pub(super) fn peer() -> PeerDisplayState {
        let (a, _) = crate::e2e::generate_static_keypair().unwrap();
        let (b, _) = crate::e2e::generate_static_keypair().unwrap();
        let mut client =
            crate::e2e::NoiseHandshake::new_initiator(&a, &[7; 32], b"admission-test").unwrap();
        let mut daemon =
            crate::e2e::NoiseHandshake::new_responder(&b, &[7; 32], b"admission-test").unwrap();
        daemon
            .read_message(&client.write_message(b"").unwrap())
            .unwrap();
        client
            .read_message(&daemon.write_message(b"").unwrap())
            .unwrap();
        daemon
            .read_message(&client.write_message(b"").unwrap())
            .unwrap();
        let mut peer = PeerDisplayState::new(Arc::from("browser"), PeerTransport::Edge);
        peer.authenticated = true;
        peer.noise = Some(daemon.into_transport().unwrap());
        peer.signal_session_id = "session".into();
        peer.manifest_generation = 1;
        peer.browser_address = Some("198.51.100.7".parse().unwrap());
        peer
    }

    #[test]
    fn a_claim_requires_the_exact_authenticated_session_manifest_family_and_network_epoch() {
        let epoch = Arc::new(AtomicU64::new(0));
        let claim = Claim::new(identity(), epoch.clone(), 0);
        let mut peer = peer();
        assert!(claim.authorizes(&peer));
        peer.authenticated = false;
        assert!(!claim.authorizes(&peer));
        peer.authenticated = true;
        peer.manifest_generation = 2;
        assert!(!claim.authorizes(&peer));
        peer.manifest_generation = 1;
        peer.signal_session_id = "successor".into();
        assert!(!claim.authorizes(&peer));
        peer.signal_session_id = "session".into();
        peer.browser_address = Some("2001:db8::7".parse().unwrap());
        assert!(!claim.authorizes(&peer));
        peer.browser_address = Some(identity().browser);
        let mut rebound = identity();
        rebound.rebind = 1;
        assert!(!rebound.matches(&peer));
        assert!(claim.accepts("::ffff:198.51.100.7".parse().unwrap()));
        assert!(!claim.accepts("198.51.100.8".parse().unwrap()));
        epoch.fetch_add(1, Ordering::AcqRel);
        assert!(!claim.authorizes(&peer));
        assert!(!claim.accepts("198.51.100.7".parse().unwrap()));
    }

    #[test]
    fn an_unauthenticated_connection_releases_its_claim_when_its_owner_ends() {
        let claim = Claim::new(identity(), Arc::new(AtomicU64::new(0)), 0);
        {
            let _connection = claim.connected(7);
            assert_eq!(claim.stable_connection.load(Ordering::Acquire), 8);
        }
        assert_eq!(
            claim.stable_connection.load(Ordering::Acquire),
            0,
            "a closed unauthenticated connection must not consume the listener"
        );
    }

    #[test]
    fn a_late_proof_cannot_claim_a_successor_and_authenticated_ownership_survives_close() {
        let claim = Claim::new(identity(), Arc::new(AtomicU64::new(0)), 0);
        let first = claim.connected(7).unwrap();
        assert!(claim.connected(7).is_none());
        assert_eq!(claim.stable_connection.load(Ordering::Acquire), 8);
        drop(first);
        let successor = claim.connected(8).unwrap();
        assert!(!claim.authenticate(7), "the closed connection has no claim");
        assert!(!claim.authenticated.load(Ordering::Acquire));
        assert!(claim.authenticate(8));
        drop(successor);
        assert_eq!(claim.stable_connection.load(Ordering::Acquire), 9);
        assert!(
            claim.connected(9).is_none(),
            "authentication retains the exact owner"
        );
    }

    #[tokio::test]
    async fn claim_authentication_waits_for_atomic_routing_promotion() {
        let live = super::super::loopback_pair().await;
        let (_endpoint, cert, info) = super::super::start_server(0, None).unwrap();
        let mut snapshot = WebTransportState::from_server_info(cert, &info);
        let claim = Claim::new(identity(), Arc::new(AtomicU64::new(0)), 0);
        let stable_id = live.daemon.quic_connection().stable_id();
        let ownership = claim.connected(stable_id).unwrap();
        let (sender, _receiver) = mpsc::channel(1);
        snapshot.peer_connections.insert(
            "pending".into(),
            super::super::ChannelPeerConnection {
                connection_id: 1,
                senders: super::super::ChannelSenders {
                    ctrl: sender.clone(),
                    pty: sender.clone(),
                    display_commit: sender,
                    signaling: None,
                },
            },
        );
        snapshot
            .sessions
            .insert("pending".into(), live.daemon.clone());
        snapshot
            .admission_claims
            .insert("pending".into(), claim.clone());
        let state = Arc::new(RwLock::new(snapshot));
        let read = state.read().await;
        let mut promotion =
            std::pin::pin!(super::super::upgrade_peer(&state, "pending", "browser"));
        assert!(futures::poll!(promotion.as_mut()).is_pending());
        assert!(
            !claim.authenticated.load(Ordering::Acquire),
            "a registry reader still prevents adoption"
        );
        drop(read);
        assert!(promotion.await.is_some());
        assert!(claim.authenticated.load(Ordering::Acquire));
        assert!(state.read().await.sessions.contains_key("browser"));
        drop(ownership);
        assert_eq!(
            claim.stable_connection.load(Ordering::Acquire),
            stable_id as u64 + 1
        );
    }

    #[test]
    fn separate_claims_allow_concurrent_browsers_and_fresh_source_ports_without_reusing_a_grant() {
        let epoch = Arc::new(AtomicU64::new(0));
        let first = Claim::new(identity(), epoch.clone(), 0);
        let second = Claim::new(identity(), epoch.clone(), 0);
        assert_ne!(first.id, second.id);
        let _first_connection = first.connected(10).unwrap();
        assert!(
            first.connected(11).is_none(),
            "one grant cannot admit a second QUIC owner"
        );
        let _second_connection = second
            .connected(11)
            .expect("same public IP has independent socket ownership");
        first.live.store(false, Ordering::Release);
        let reconnect = Claim::new(identity(), epoch, 0);
        let _reconnect_connection = reconnect
            .connected(12)
            .expect("a fresh claim has a fresh grant");
        assert!(
            second.accepts(identity().browser),
            "cancelling a loser preserves another session"
        );
    }

    #[test]
    fn helper_packets_are_well_formed_bounded_and_name_only_the_owned_media_port() {
        let path = Path {
            index: 1,
            name: "test".into(),
            address: "192.0.2.10".parse().unwrap(),
        };
        let rrq = tftp_request(&[0x42; 16]);
        assert_eq!(&rrq[..2], &[0, 1]);
        assert!(rrq.ends_with(b"\0octet\0"));
        assert!(rrq.len() < 512);
        let invite = sip_request(&path, 40001, 49152, identity().browser, &[0x42; 16]);
        let text = std::str::from_utf8(&invite).unwrap();
        let (headers, body) = text.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("INVITE sip:merkur-"));
        assert!(headers.contains("@198.51.100.7 SIP/2.0\r\n"));
        assert!(headers.ends_with(&format!("Content-Length: {}", body.len())));
        assert!(body.contains("m=audio 49152 RTP/AVP 0\r\n"));
        assert!(!body.contains("49153"));
        assert!(invite.len() < 1200);
    }

    #[test]
    fn ipv6_sip_names_the_owned_address_in_sdp_and_brackets_sip_hosts() {
        let path = Path {
            index: 1,
            name: "test".into(),
            address: "2001:db8::10".parse().unwrap(),
        };
        let invite = sip_request(
            &path,
            40001,
            49152,
            "2001:db8::7".parse().unwrap(),
            &[0x42; 16],
        );
        let text = std::str::from_utf8(&invite).unwrap();
        let (headers, body) = text.split_once("\r\n\r\n").unwrap();
        assert!(headers.contains("@[2001:db8::7] SIP/2.0\r\n"));
        assert!(headers.contains("Via: SIP/2.0/UDP [2001:db8::10]:40001;"));
        assert!(headers.contains("From: <sip:m@[2001:db8::10]>;"));
        assert!(headers.contains("To: <sip:merkur@[2001:db8::7]>\r\n"));
        assert!(headers.contains("Contact: <sip:merkur@[2001:db8::10]:40001>\r\n"));
        assert!(headers.ends_with(&format!("Content-Length: {}", body.len())));
        assert!(body.contains("o=m 1 1 IN IP6 2001:db8::10\r\n"));
        assert!(body.contains("c=IN IP6 2001:db8::10\r\n"));
        assert!(body.contains("m=audio 49152 RTP/AVP 0\r\n"));
        assert!(!body.contains("49153"));
        assert!(invite.len() < 1200);
    }

    #[test]
    fn ipv6_claims_bind_the_exact_session_address_manifest_and_network_epoch() {
        let mut identity = identity();
        identity.browser = "2001:db8::7".parse().unwrap();
        let epoch = Arc::new(AtomicU64::new(0));
        let claim = Claim::new(identity, epoch.clone(), 0);
        let mut peer = peer();
        peer.browser_address = Some(claim.identity.browser);
        assert!(claim.authorizes(&peer));
        let mut rebound = claim.identity.clone();
        rebound.rebind = 1;
        assert!(!rebound.matches(&peer));
        assert!(claim.accepts(claim.identity.browser));
        assert!(!claim.accepts("2001:db8::8".parse().unwrap()));
        assert!(!claim.accepts("198.51.100.7".parse().unwrap()));
        peer.browser_address = Some("2001:db8::8".parse().unwrap());
        assert!(!claim.authorizes(&peer));
        peer.browser_address = Some(claim.identity.browser);
        peer.manifest_generation += 1;
        assert!(!claim.authorizes(&peer));
        peer.manifest_generation -= 1;
        peer.signal_session_id = "successor".into();
        assert!(!claim.authorizes(&peer));
        epoch.fetch_add(1, Ordering::AcqRel);
        assert!(!claim.accepts(claim.identity.browser));
    }

    #[tokio::test]
    async fn ipv6_queue_uses_the_trusted_address_without_a_stun_credential() {
        let (_endpoint, cert, info) = super::super::start_server(0, None).unwrap();
        let mut snapshot = WebTransportState::from_server_info(cert, &info);
        let (handle, mut commands) = channel();
        snapshot.admission_requests = Some(handle);
        snapshot.admission_config = Some(info.admission_config.clone());
        assert!(snapshot.admission_credential.is_none());
        let state = Arc::new(RwLock::new(snapshot));
        let snapshot = state.read().await;
        let mut peer = peer();
        peer.browser_address = Some("2001:db8::7".parse().unwrap());
        let mut manifest = serde_json::json!({ "candidates": [], "admission_pending": false });
        queue(&state, &snapshot, &peer, &mut manifest);
        let Command::Prepare(request) = commands.try_recv().unwrap() else {
            panic!("preparation queued");
        };
        assert_eq!(request.identity.browser, peer.browser_address.unwrap());
        assert!(request.credential.is_none());
        assert_eq!(manifest["admission_pending"], true);
        for address in [
            "fd00::7",
            "fe80::7",
            "::1",
            "198.51.100.7",
            "::ffff:198.51.100.7",
        ] {
            peer.browser_address = Some(address.parse().unwrap());
            let mut manifest = serde_json::json!({ "admission_pending": false });
            queue(&state, &snapshot, &peer, &mut manifest);
            assert!(commands.try_recv().is_err(), "{address}");
            assert_eq!(manifest["admission_pending"], false);
        }
    }

    pub(super) fn loopback_path(ipv6: bool) -> Path {
        let interface = netdev::get_interfaces()
            .into_iter()
            .find(|iface| iface.is_loopback())
            .unwrap();
        Path {
            index: interface.index,
            name: interface.name,
            address: if ipv6 { "::1" } else { "127.0.0.1" }.parse().unwrap(),
        }
    }

    #[test]
    fn companion_ownership_is_distinct_across_addresses_families_and_interfaces() {
        let v4 = loopback_path(false);
        let v6 = loopback_path(true);
        let (port, first, second) = (61000..62000)
            .step_by(2)
            .find_map(|port| {
                Some((
                    port,
                    reserve_pair(&v4, port).ok()?,
                    reserve_pair(&v6, port).ok()?,
                ))
            })
            .unwrap();
        let owner = Retirement::new();
        let (v4_media, v4_companion) = first;
        let (v6_media, v6_companion) = second;
        assert_eq!(
            v4_companion.local_addr().unwrap(),
            SocketAddr::from((v4.address, port + 1))
        );
        assert_eq!(
            v6_companion.local_addr().unwrap(),
            SocketAddr::from((v6.address, port + 1))
        );
        assert!(socket2::SockRef::from(&v6_companion).only_v6().unwrap());
        let v4_key = v4.companion_key(port + 1);
        let v6_key = v6.companion_key(port + 1);
        assert_ne!(v4_key, v6_key);
        let mut another_address = v6.clone();
        another_address.address = "2001:db8::10".parse().unwrap();
        assert_ne!(v6_key, another_address.companion_key(port + 1));
        let mut another_interface = v6.clone();
        another_interface.index += 1;
        assert_ne!(v6_key, another_interface.companion_key(port + 1));
        {
            let mut companions = owner.companions.lock().unwrap();
            companions.insert(v4_key, Arc::new(v4_companion));
            companions.insert(v6_key, Arc::new(v6_companion));
        }
        drop((v4_media, v6_media));
        for path in [&v4, &v6] {
            assert_eq!(
                bind(path, port + 1).unwrap_err().kind(),
                std::io::ErrorKind::AddrInUse
            );
        }
    }

    #[test]
    fn an_occupied_companion_refuses_the_pair_and_a_reserved_pair_excludes_unrelated_services() {
        let interface = netdev::get_interfaces()
            .into_iter()
            .find(|iface| iface.is_loopback() && !iface.ipv4.is_empty())
            .unwrap();
        let path = Path {
            index: interface.index,
            name: interface.name,
            address: IpAddr::V4(interface.ipv4[0].addr()),
        };
        assert_eq!(
            reserve_pair(&path, 49153).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
        let (media, occupied) = (61000..62000)
            .step_by(2)
            .find_map(|port| {
                let guard = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port + 1)).ok()?;
                let media = bind(&path, port).ok()?;
                Some((media, guard))
            })
            .unwrap();
        assert_eq!(
            reserve_companion(&path, media).unwrap_err().kind(),
            std::io::ErrorKind::AddrInUse
        );
        drop(occupied);
        let owner = Retirement::new();
        let (media, companion) = pair(&path, &owner).unwrap();
        let port = media.local_addr().unwrap().port();
        assert_eq!(media.local_addr().unwrap().port() % 2, 0);
        assert_eq!(companion.local_addr().unwrap().port(), port + 1);
        assert_eq!(
            UdpSocket::bind((path.address, port + 1))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AddrInUse
        );
    }

    #[test]
    fn retiring_media_cannot_release_a_helper_admitted_companion_to_an_unrelated_service() {
        let interface = netdev::get_interfaces()
            .into_iter()
            .find(|iface| iface.is_loopback() && !iface.ipv4.is_empty())
            .unwrap();
        let path = Path {
            index: interface.index,
            name: interface.name,
            address: IpAddr::V4(interface.ipv4[0].addr()),
        };
        let owner = Retirement::new();
        let (media, companion) = pair(&path, &owner).unwrap();
        let port = companion.local_addr().unwrap().port();
        drop((media, companion));
        assert_eq!(
            UdpSocket::bind((path.address, port)).unwrap_err().kind(),
            std::io::ErrorKind::AddrInUse
        );
        drop(owner);
        assert!(UdpSocket::bind((path.address, port)).is_ok());
    }

    #[test]
    fn the_companion_reservation_bound_reuses_owned_pairs_without_growing_descriptors() {
        let interface = netdev::get_interfaces()
            .into_iter()
            .find(|iface| iface.is_loopback() && !iface.ipv4.is_empty())
            .unwrap();
        let path = Path {
            index: interface.index,
            name: interface.name,
            address: IpAddr::V4(interface.ipv4[0].addr()),
        };
        let owner = Retirement::new();
        for port in (49152..65534).step_by(2) {
            if let Ok((media, companion)) = reserve_pair(&path, port) {
                owner
                    .companions
                    .lock()
                    .unwrap()
                    .insert(path.companion_key(port + 1), Arc::new(companion));
                drop(media);
            }
            if owner.companions.lock().unwrap().len() == MAX_COMPANIONS {
                break;
            }
        }
        assert_eq!(owner.companions.lock().unwrap().len(), MAX_COMPANIONS);
        assert_eq!(
            pair(&loopback_path(true), &owner).unwrap_err().kind(),
            std::io::ErrorKind::AddrNotAvailable,
            "a full IPv4 reservation set cannot supply an IPv6 companion"
        );
        let (media, companion) = pair(&path, &owner).unwrap();
        let companion_port = media.local_addr().unwrap().port() + 1;
        let companions = owner.companions.lock().unwrap();
        assert_eq!(companions.len(), MAX_COMPANIONS);
        assert!(Arc::ptr_eq(
            &companion,
            &companions[&path.companion_key(companion_port)]
        ));
        assert_eq!(
            UdpSocket::bind((path.address, companion_port))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AddrInUse
        );
    }

    #[tokio::test]
    async fn completion_survives_a_full_wake_queue_and_an_old_completion_cannot_retire_a_new_cohort()
     {
        let (messages, _) = mpsc::channel(1);
        let (events, _) = mpsc::channel(1);
        let (handle, mut commands) = channel();
        let mut owner = Owner::new(messages, events.clone(), &handle);
        let claim = Claim::new(identity(), handle.epoch.clone(), 0);
        owner.work.insert(
            Arc::from("browser"),
            Work {
                identity: identity(),
                epoch: 0,
                task: Some(tokio::spawn(std::future::pending())),
                retirements: owner.retirements.clone(),
                bindings: vec![Binding {
                    claim: claim.clone(),
                    retirements: owner.retirements.clone(),
                    server: None,
                    events,
                    companion: None,
                    signaling: None,
                    enhancement: None,
                    media: Arc::new(Mutex::new(Some(Vec::new()))),
                }],
            },
        );
        let mut peers = PeerMap::from([(Arc::from("browser"), peer())]);
        for _ in 0..CAPACITY {
            assert!(handle.try_send(Command::Reconcile).is_ok());
        }
        peers.get_mut("browser").unwrap().admission_done_generation = Some(0);
        owner.command(commands.recv().await.unwrap(), &peers);
        assert!(
            owner.work.contains_key("browser"),
            "stale completion is ignored"
        );
        assert!(handle.try_send(Command::Reconcile).is_ok());
        peers.get_mut("browser").unwrap().admission_done_generation = Some(1);
        assert!(
            handle.try_send(Command::Reconcile).is_err(),
            "queue is full"
        );
        owner.command(commands.recv().await.unwrap(), &peers);
        assert!(
            owner.work.is_empty(),
            "an existing wake observes durable completion"
        );
        assert!(!claim.live.load(Ordering::Acquire));
        owner.shutdown().await;
    }

    #[tokio::test]
    async fn listener_retirement_cannot_drain_another_listeners_authenticated_session() {
        let first = super::super::loopback_pair().await;
        let other = super::super::loopback_pair().await;
        let (_, cert, info) = super::super::start_server(0, None).unwrap();
        let state = Arc::new(RwLock::new(WebTransportState::from_server_info(
            cert, &info,
        )));
        {
            let mut state = state.write().await;
            for (id, listener, name, connection) in [
                (1, 100, "one", first.daemon.clone()),
                (2, 200, "two", other.daemon.clone()),
            ] {
                let (senders, _) = super::super::captured_lanes();
                state.connection_listeners.insert(id, listener);
                state.lifecycle_peers.insert(id, format!("wt-pending-{id}"));
                state.peer_connections.insert(
                    name.into(),
                    crate::network::peer::ChannelPeerConnection {
                        senders,
                        connection_id: id,
                    },
                );
                state.sessions.insert(name.into(), connection);
            }
        }
        let retired = super::super::retire_listener_connections(&state, 100).await;
        assert_eq!(retired.len(), 1);
        assert_eq!(retired[0].connection_id, 1);
        assert!(first.daemon.is_closed());
        assert!(!other.daemon.is_closed());
        let state = state.read().await;
        assert!(state.sessions.contains_key("two"));
        assert!(state.peer_connections.contains_key("two"));
        assert_eq!(state.connection_listeners.get(&2), Some(&200));
    }

    #[tokio::test]
    async fn network_invalidation_preserves_the_exact_adopted_connection_and_retires_losers() {
        let live = super::super::loopback_pair().await;
        let (messages, _) = mpsc::channel(1);
        let (events, _) = mpsc::channel(4);
        let (handle, _) = channel();
        let mut owner = Owner::new(messages, events.clone(), &handle);
        let mut peer = peer();
        let winner = Claim::new(identity(), handle.epoch.clone(), 0);
        let stable_id = live.daemon.quic_connection().stable_id();
        let connection_claim = winner.connected(stable_id).unwrap();
        assert!(winner.authenticate(stable_id));
        drop(connection_claim);
        peer.direct_session = Some(super::super::DirectSession::from_connection(
            live.daemon.clone(),
        ));
        peer.paths.webtransport.available = true;
        let loser = Claim::new(identity(), handle.epoch, 0);
        let binding = |claim| Binding {
            claim,
            retirements: owner.retirements.clone(),
            server: None,
            events: events.clone(),
            companion: None,
            signaling: None,
            enhancement: None,
            media: Arc::new(Mutex::new(Some(Vec::new()))),
        };
        owner.work.insert(
            Arc::from("browser"),
            Work {
                identity: identity(),
                epoch: 0,
                task: Some(tokio::spawn(std::future::pending())),
                retirements: owner.retirements.clone(),
                bindings: vec![binding(winner.clone()), binding(loser.clone())],
            },
        );
        let peers = PeerMap::from([(Arc::from("browser"), peer)]);
        owner.invalidate(&peers);
        assert!(owner.work.is_empty());
        assert_eq!(owner.adopted.len(), 1);
        assert_eq!(owner.adopted[0].claim.id, winner.id);
        assert!(!loser.live.load(Ordering::Acquire));
        assert!(
            !winner.authorizes(&peers["browser"]),
            "old epoch cannot admit another connection"
        );
        assert!(
            !live.daemon.is_closed(),
            "the adopted session outlives losing admission state"
        );
    }
}

#[cfg(test)]
#[path = "admission_router_tests.rs"]
mod router_tests;
