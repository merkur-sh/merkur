//! Allocation observation and intermediate-grant custody for one admission claim.

use super::*;
use merkur_traversal::{egress, portmap, sip as wire};
use tokio::sync::oneshot;

// Cold-path sends and revocation share this gate. No packet can leave after a
// binding retires, a network epoch changes, or session authentication commits.
pub(super) static SEND_GATE: Mutex<()> = Mutex::new(());

pub(super) struct Offer {
    socket: UdpSocket,
    packet: Vec<u8>,
}

impl Claim {
    fn send_sip(&self, socket: &UdpSocket, packet: &[u8]) -> std::io::Result<bool> {
        let _send = SEND_GATE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.authenticated.load(Ordering::Acquire) {
            return Ok(false);
        }
        if !self.accepts(self.identity.browser) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "retired admission",
            ));
        }
        socket.set_nonblocking(true)?;
        let socket = socket.try_clone()?;
        socket.send_to(packet, (self.identity.browser, 5060))?;
        *self
            .sip_offer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Offer {
            socket,
            packet: packet.to_vec(),
        });
        Ok(true)
    }

    pub(in crate::webtransport) fn handshake_completed(&self, remote: IpAddr) {
        let _send = SEND_GATE.lock().unwrap();
        if !self.accepts(remote) || self.authenticated.load(Ordering::Acquire) {
            return;
        }
        let offer = self.sip_offer.lock().unwrap();
        if let Some(offer) = offer.as_ref()
            && let Err(error) = offer
                .socket
                .send_to(&offer.packet, (self.identity.browser, 5060))
        {
            warn!(claim = self.id, %error, "direct admission SIP reoffer failed");
        }
    }

    pub(super) fn retire(&self) {
        let _send = SEND_GATE.lock().unwrap();
        self.live.store(false, Ordering::Release);
        self.sip_offer.lock().unwrap().take();
    }
}

pub(super) fn send(
    binding: &mut Binding,
    path: &Path,
    discovery: &Arc<DiscoverySocket>,
    observed: SocketAddr,
    nonce: [u8; 16],
) -> Result<Vec<u8>, String> {
    use wtransport::quinn::AsyncUdpSocket;
    let browser = binding.claim.identity.browser;
    let signaling = binding
        .signaling
        .as_ref()
        .ok_or("missing SIP signaling socket")?;
    let bytes = sip_request(
        path,
        signaling
            .local_addr()
            .map_err(|error| error.to_string())?
            .port(),
        discovery
            .local_addr()
            .map_err(|error| error.to_string())?
            .port(),
        browser,
        &nonce,
    );
    let observation = wire::Observation::new(signaling, path.index, browser).ok();
    if path.address.is_ipv4() {
        binding.enhancement = Some(
            Enhancement {
                path: path.clone(),
                claim: binding.claim.clone(),
                socket: discovery.clone(),
                companion: binding
                    .companion
                    .as_ref()
                    .ok_or("missing SIP companion")?
                    .clone(),
                signaling: signaling.try_clone().map_err(|error| error.to_string())?,
                observation,
                nonce,
                observed,
                retirements: binding.retirements.clone(),
                media: binding.media.clone(),
            }
            .run()
            .boxed(),
        );
    }
    if !binding
        .claim
        .send_sip(signaling, &bytes)
        .map_err(|error| error.to_string())?
    {
        binding.enhancement = None;
    }
    Ok(bytes)
}

pub(super) struct MediaOwner(watch::Sender<bool>);

impl Drop for MediaOwner {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

struct Media {
    first: super::super::router_grants::Lease,
    second: super::super::router_grants::Lease,
}

enum Allocation {
    Public(super::super::router_grants::Lease),
    Intermediate(Media),
}

impl Media {
    fn live(&self) -> bool {
        self.first.is_owned()
            && self.second.is_owned()
            && portmap::media::compatible(&self.first, &self.second)
    }
}

pub(super) type MediaSlot = Arc<Mutex<Option<Vec<MediaOwner>>>>;

#[derive(Clone)]
struct Custody {
    media: MediaSlot,
    retirements: Retirement,
    observed: IpAddr,
}

impl Custody {
    fn retain(&self, grant: &super::super::router_grants::Lease) -> bool {
        if grant.lifetime.is_zero() {
            return false;
        }
        let mut media = self
            .media
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(media) = media.as_mut() else {
            return false;
        };
        media.push(MediaOwner::maintain(grant.clone(), &self.retirements));
        true
    }
}

impl MediaOwner {
    fn maintain(mut grant: super::super::router_grants::Lease, retirements: &Retirement) -> Self {
        let (stop, mut stopping) = watch::channel(false);
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = stopping.changed() => break,
                    () = tokio::time::sleep(grant.renew_after()) => {}
                }
                let Some(_renewal) = grant.renewing() else {
                    break;
                };
                let mut renewed = (*grant).clone();
                if !portmap::renew(&mut renewed).await {
                    // Failed renewal cannot delete state under an authenticated carrier.
                    drop(stopping.changed().await);
                    break;
                }
                grant = grant.renewed(renewed);
            }
        });
        retirements.track(task);
        Self(stop)
    }
}

impl Retirement {
    fn gateway_factory(&self) -> super::super::router_grants::Factory {
        let mut gateways = self
            .gateways
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Resource bound: each reserved media/companion pair can own two grants.
        gateways
            .get_or_insert_with(|| {
                super::super::router_grants::Owner::with_capacity(MAX_COMPANIONS * 2)
            })
            .factory()
    }

    async fn acquire_media(
        &self,
        socket: Arc<DiscoverySocket>,
        companion: Arc<DiscoverySocket>,
        path: &Path,
        custody: Custody,
    ) -> Option<Allocation> {
        let IpAddr::V4(local) = path.address else {
            return None;
        };
        let mut egress = tokio::task::spawn_blocking(move || {
            egress::resolve_egress_path(Some(IpAddr::V4(local)))
        })
        .await
        .ok()??;
        if egress.interface_index != path.index || egress.local_ipv4 != local {
            return None;
        }
        egress.interface_name = path.name.clone();
        self.acquire_media_with(
            socket,
            companion,
            egress,
            portmap::GatewayPorts::STANDARD,
            portmap::RetransmitSchedule::PRODUCTION,
            custody,
        )
        .await
    }

    async fn acquire_media_with(
        &self,
        socket: Arc<DiscoverySocket>,
        companion: Arc<DiscoverySocket>,
        egress: egress::EgressPath,
        ports: portmap::GatewayPorts,
        schedule: portmap::RetransmitSchedule,
        custody: Custody,
    ) -> Option<Allocation> {
        let address = IpAddr::V4(egress.local_ipv4);
        let port = companion.local_addr().ok()?.port().checked_sub(1)?;
        let factory = self.gateway_factory();
        let first_reservation = factory.reserve(address, port, socket)?;
        let second_reservation = factory.reserve(address, port + 1, companion)?;
        let (sender, receiver) = oneshot::channel();
        // Acquisition must finish even if its candidate is cancelled: a late
        // positive MAP response still creates owned cleanup, with both sockets pinned.
        let task = tokio::spawn(async move {
            let acquired = async {
                let first = portmap::media::acquire(port, &egress, ports, schedule).await?;
                let first = factory.lease(*first, first_reservation);
                if !custody.retain(&first) {
                    return None;
                }
                if first.external.port() != 0 && first.external.ip() == custody.observed {
                    return Some(Allocation::Public(first));
                }
                if first.external.port() == 0 || !first.external.port().is_multiple_of(2) {
                    return None;
                }
                let second = portmap::media::companion(&first, port + 1).await?;
                let second = factory.lease(*second, second_reservation);
                if !custody.retain(&second) {
                    return None;
                }
                let media = Media { first, second };
                media.live().then_some(Allocation::Intermediate(media))
            }
            .await;
            drop(sender.send(acquired));
        });
        self.track(task);
        receiver.await.ok().flatten()
    }
}

pub(super) struct Enhancement {
    pub path: Path,
    pub claim: Arc<Claim>,
    pub socket: Arc<DiscoverySocket>,
    pub companion: Arc<DiscoverySocket>,
    pub signaling: UdpSocket,
    pub observation: Option<wire::Observation>,
    pub nonce: [u8; 16],
    pub observed: SocketAddr,
    pub retirements: Retirement,
    pub media: MediaSlot,
}

impl Enhancement {
    pub(super) async fn run(mut self) -> Option<serde_json::Value> {
        let IpAddr::V4(public) = self.observed.ip() else {
            return None;
        };
        if let Some(endpoint) = self.receive(public).await {
            info!(claim = self.claim.id, %endpoint, "direct admission SIP allocation observed");
            return Some(candidate(endpoint, CandidateFlavor::Sip, self.claim.id));
        }
        let allocation = self
            .retirements
            .acquire_media(
                self.socket.clone(),
                self.companion.clone(),
                &self.path,
                Custody {
                    media: self.media.clone(),
                    retirements: self.retirements.clone(),
                    observed: self.observed.ip(),
                },
            )
            .await?;
        if !self.claim.accepts(self.claim.identity.browser) {
            return None;
        }
        let (endpoint, kind) = match allocation {
            Allocation::Public(grant) => {
                if !grant.is_owned() || grant.expires_at <= std::time::Instant::now() {
                    return None;
                }
                (grant.external, CandidateFlavor::NatMap)
            }
            Allocation::Intermediate(media) => {
                self.observation.as_ref()?;
                ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut self.nonce)
                    .ok()?;
                let packet = wire::offer(
                    self.signaling.local_addr().ok()?,
                    media.first.external,
                    self.claim.identity.browser,
                    &self.nonce,
                );
                if !self.claim.send_sip(&self.signaling, &packet).ok()? {
                    return None;
                }
                let endpoint = self.receive(public).await?;
                if !media.live() {
                    return None;
                }
                (endpoint, CandidateFlavor::Sip)
            }
        };
        if !self.claim.accepts(self.claim.identity.browser) {
            return None;
        }
        info!(claim = self.claim.id, %endpoint, ?kind, "direct admission mapped allocation prepared");
        Some(candidate(endpoint, kind, self.claim.id))
    }

    async fn receive(&self, public: std::net::Ipv4Addr) -> Option<SocketAddr> {
        let observation = self.observation.as_ref()?;
        tokio::time::timeout(
            wire::OBSERVATION_BUDGET,
            observation.receive(&self.nonce, public),
        )
        .await
        .ok()?
        .ok()
        .flatten()
    }
}

pub(super) fn candidate(
    endpoint: SocketAddr,
    kind: CandidateFlavor,
    admission: u64,
) -> serde_json::Value {
    serde_json::json!({ "addr": endpoint.ip(), "port": endpoint.port(), "kind": kind, "scope": "public", "admission": admission })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_identity() -> Identity {
        Identity {
            peer: Arc::from("browser"),
            session: "session".into(),
            rebind: 0,
            manifest: 1,
            browser: "127.0.0.1".parse().unwrap(),
        }
    }

    #[test]
    fn completed_handshakes_reoffer_only_the_current_live_unauthenticated_claim() {
        let browser: IpAddr = "127.0.0.1".parse().unwrap();
        let receiver = UdpSocket::bind((browser, 5060)).unwrap();
        receiver
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        let signaling = UdpSocket::bind("127.0.0.1:0").unwrap();
        let epoch = Arc::new(AtomicU64::new(0));
        let claim = Claim::new(
            Identity {
                browser,
                ..test_identity()
            },
            epoch.clone(),
            0,
        );
        let receive = |expected: &[u8]| {
            let mut bytes = [0; 64];
            let (length, source) = receiver.recv_from(&mut bytes).unwrap();
            assert_eq!(&bytes[..length], expected);
            assert_eq!(source, signaling.local_addr().unwrap());
        };
        let empty = || {
            receiver.set_nonblocking(true).unwrap();
            assert_eq!(
                receiver.recv_from(&mut [0; 64]).unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
            receiver.set_nonblocking(false).unwrap();
        };
        assert!(claim.send_sip(&signaling, b"original owned media").unwrap());
        receive(b"original owned media");
        claim.handshake_completed("127.0.0.2".parse().unwrap());
        empty();
        claim.handshake_completed(browser);
        receive(b"original owned media");
        assert!(claim.send_sip(&signaling, b"composed owned media").unwrap());
        receive(b"composed owned media");
        claim.handshake_completed(browser);
        receive(b"composed owned media");
        let ownership = claim.connected(17).unwrap();
        assert!(claim.authenticate(17));
        claim.handshake_completed(browser);
        assert!(!claim.send_sip(&signaling, b"late preparation").unwrap());
        empty();
        assert!(claim.sip_offer.lock().unwrap().is_none());
        drop(ownership);

        let retired = Claim::new(
            Identity {
                browser,
                ..test_identity()
            },
            epoch.clone(),
            0,
        );
        assert!(retired.send_sip(&signaling, b"retiring").unwrap());
        receive(b"retiring");
        retired.retire();
        retired.handshake_completed(browser);
        assert!(retired.send_sip(&signaling, b"stale").is_err());
        empty();
        assert!(retired.sip_offer.lock().unwrap().is_none());

        let changed = Claim::new(
            Identity {
                browser,
                ..test_identity()
            },
            epoch.clone(),
            0,
        );
        assert!(changed.send_sip(&signaling, b"old network").unwrap());
        receive(b"old network");
        {
            let _send = SEND_GATE.lock().unwrap();
            epoch.fetch_add(1, Ordering::AcqRel);
        }
        changed.handshake_completed(browser);
        assert!(changed.send_sip(&signaling, b"old network").is_err());
        empty();
    }

    #[tokio::test]
    async fn a_public_odd_mapping_needs_no_companion_grant() {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let gateway_port = socket.local_addr().unwrap().port();
        let retirement = Retirement::new();
        let path = super::super::tests::loopback_path(false);
        let (listener, companion) = pair(&path, &retirement).unwrap();
        let media_port = listener.local_addr().unwrap().port();
        let socket_owner = listener;
        let released = Arc::downgrade(&socket_owner);
        let gateway = tokio::spawn(async move {
            let mut buffer = [0; 100];
            loop {
                let (length, from) = socket.recv_from(&mut buffer).await.unwrap();
                let bytes = &buffer[..length];
                let deleting = length == 12 && bytes[8..12] == [0; 4];
                let response = if bytes[0] == 2 {
                    vec![0, 0x80, 0, 1, 0, 0, 0, 0]
                } else if length == 2 {
                    vec![0, 0x80, 0, 0, 0, 0, 0, 5, 127, 0, 0, 1]
                } else {
                    let internal = u16::from_be_bytes(bytes[4..6].try_into().unwrap());
                    assert_eq!(
                        internal, media_port,
                        "public mapping must not allocate RTCP"
                    );
                    let mut answer = vec![0, 0x81, 0, 0, 0, 0, 0, 5];
                    answer.extend_from_slice(&internal.to_be_bytes());
                    answer.extend_from_slice(&45001u16.to_be_bytes());
                    answer.extend_from_slice(if deleting { &[0; 4] } else { &[0, 0, 0, 120] });
                    answer
                };
                socket.send_to(&response, from).await.unwrap();
                if deleting {
                    return;
                }
            }
        });
        let custody = Custody {
            observed: std::net::Ipv4Addr::LOCALHOST.into(),
            ..custody(&retirement)
        };
        let media = custody.media.clone();
        let allocation = retirement
            .acquire_media_with(
                socket_owner,
                companion,
                egress::EgressPath {
                    local_ipv4: std::net::Ipv4Addr::LOCALHOST,
                    interface_index: path.index,
                    interface_name: path.name,
                    gateway: Some(std::net::Ipv4Addr::LOCALHOST),
                },
                portmap::GatewayPorts {
                    pxp: gateway_port,
                    ..portmap::GatewayPorts::STANDARD
                },
                portmap::RetransmitSchedule::PRODUCTION,
                custody,
            )
            .await;
        assert!(
            allocation.is_some(),
            "an odd public UDP mapping is a usable WebTransport path"
        );
        drop(allocation);
        drop(media.lock().unwrap().take());
        retirement.shutdown().await;
        gateway.await.unwrap();
        assert!(released.upgrade().is_none());
    }

    fn custody(retirements: &Retirement) -> Custody {
        Custody {
            media: Arc::new(Mutex::new(Some(Vec::new()))),
            retirements: retirements.clone(),
            observed: "198.51.100.1".parse().unwrap(),
        }
    }

    struct Gateway {
        port: u16,
        requests: mpsc::Receiver<(Vec<u8>, oneshot::Sender<()>)>,
        task: JoinHandle<()>,
    }

    impl Gateway {
        async fn start() -> Self {
            let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let port = socket.local_addr().unwrap().port();
            let (sender, requests) = mpsc::channel(4);
            let task = tokio::spawn(async move {
                let mut buffer = [0; 100];
                loop {
                    let (length, client) = socket.recv_from(&mut buffer).await.unwrap();
                    let bytes = &buffer[..length];
                    let response = if bytes[0] == 2 {
                        vec![0, 0x80, 0, 1, 0, 0, 0, 0]
                    } else if bytes.len() == 2 {
                        let mut response = vec![0, 0x80, 0, 0, 0, 0, 0, 5];
                        response.extend_from_slice(&[100, 64, 0, 2]);
                        response
                    } else {
                        let (ack, response) = oneshot::channel();
                        sender.send((bytes.to_vec(), ack)).await.unwrap();
                        response.await.unwrap();
                        let mut response = vec![0, 0x81, 0, 0, 0, 0, 0, 5];
                        response.extend_from_slice(&bytes[4..8]);
                        response.extend_from_slice(if bytes[8..12] == [0; 4] {
                            &[0; 4]
                        } else {
                            &[0, 0, 0, 120]
                        });
                        response
                    };
                    socket.send_to(&response, client).await.unwrap();
                }
            });
            Self {
                port,
                requests,
                task,
            }
        }

        async fn next(&mut self, deletion: bool) -> oneshot::Sender<()> {
            let (bytes, response) = self.requests.recv().await.unwrap();
            assert_eq!(bytes[8..12] == [0; 4], deletion);
            response
        }
    }

    #[tokio::test]
    async fn cancellation_during_a_companion_map_retains_both_tuples_until_late_grants_are_deleted()
    {
        let mut gateway = Gateway::start().await;
        let retirement = Retirement::new();
        let path = super::super::tests::loopback_path(false);
        let (socket, companion) = pair(&path, &retirement).unwrap();
        let address = socket.local_addr().unwrap();
        let released = Arc::downgrade(&socket);
        let egress = egress::EgressPath {
            local_ipv4: std::net::Ipv4Addr::LOCALHOST,
            interface_index: path.index,
            interface_name: path.name,
            gateway: Some(std::net::Ipv4Addr::LOCALHOST),
        };
        let ports = portmap::GatewayPorts {
            pxp: gateway.port,
            ..portmap::GatewayPorts::STANDARD
        };
        let allocation_owner = retirement.clone();
        let custody = custody(&retirement);
        let media = custody.media.clone();
        let acquiring = tokio::spawn(async move {
            allocation_owner
                .acquire_media_with(
                    socket,
                    companion,
                    egress,
                    ports,
                    portmap::RetransmitSchedule::PRODUCTION,
                    custody,
                )
                .await
        });
        gateway.next(false).await.send(()).unwrap();
        let late = gateway.next(false).await;
        acquiring.abort();
        assert!(matches!(acquiring.await, Err(error) if error.is_cancelled()));
        drop(media.lock().unwrap().take());
        late.send(()).unwrap();
        let deleting = gateway.next(true).await;
        assert!(
            UdpSocket::bind(address).is_err(),
            "late acquisition still owns the media tuple"
        );
        deleting.send(()).unwrap();
        gateway.next(true).await.send(()).unwrap();
        retirement.shutdown().await;
        assert!(
            released.upgrade().is_none(),
            "both gateway deletions released the owned socket"
        );
        gateway.task.abort();
    }

    #[tokio::test]
    async fn a_live_binding_keeps_late_grants_when_its_discovery_receiver_has_been_cancelled() {
        let mut gateway = Gateway::start().await;
        let retirement = Retirement::new();
        let path = super::super::tests::loopback_path(false);
        let (socket, companion) = pair(&path, &retirement).unwrap();
        let address = socket.local_addr().unwrap();
        let released = Arc::downgrade(&socket);
        let egress = egress::EgressPath {
            local_ipv4: std::net::Ipv4Addr::LOCALHOST,
            interface_index: path.index,
            interface_name: path.name,
            gateway: Some(std::net::Ipv4Addr::LOCALHOST),
        };
        let ports = portmap::GatewayPorts {
            pxp: gateway.port,
            ..portmap::GatewayPorts::STANDARD
        };
        let custody = custody(&retirement);
        let media = custody.media.clone();
        let allocation_owner = retirement.clone();
        let acquiring = tokio::spawn(async move {
            allocation_owner
                .acquire_media_with(
                    socket,
                    companion,
                    egress,
                    ports,
                    portmap::RetransmitSchedule::PRODUCTION,
                    custody,
                )
                .await
        });
        gateway.next(false).await.send(()).unwrap();
        let late = gateway.next(false).await;
        acquiring.abort();
        assert!(matches!(acquiring.await, Err(error) if error.is_cancelled()));
        late.send(()).unwrap();
        // The acquisition task's completion is the barrier, not a guessed delay.
        while !retirement
            .tasks
            .lock()
            .unwrap()
            .iter()
            .any(JoinHandle::is_finished)
        {
            tokio::task::yield_now().await;
        }
        assert_eq!(media.lock().unwrap().as_ref().unwrap().len(), 2);
        assert!(UdpSocket::bind(address).is_err());
        drop(media.lock().unwrap().take());
        gateway.next(true).await.send(()).unwrap();
        gateway.next(true).await.send(()).unwrap();
        retirement.shutdown().await;
        // Another parallel test may bind the released ephemeral port immediately.
        // Observe this socket's destruction rather than a new bind's availability.
        assert!(released.upgrade().is_none());
        gateway.task.abort();
    }
}
