//! Allocation observation and intermediate-grant custody for one admission claim.

use super::*;
use merkur_traversal::{egress, portmap, sip as wire};
use tokio::sync::oneshot;

pub(super) async fn send(
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
    let signaling = signaling.try_clone().map_err(|error| error.to_string())?;
    let packet = bytes.clone();
    tokio::task::spawn_blocking(move || signaling.send_to(&packet, (browser, 5060)))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
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
        companion: Arc<UdpSocket>,
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
        companion: Arc<UdpSocket>,
        egress: egress::EgressPath,
        ports: portmap::GatewayPorts,
        schedule: portmap::RetransmitSchedule,
        custody: Custody,
    ) -> Option<Allocation> {
        let address = IpAddr::V4(egress.local_ipv4);
        let port = companion.local_addr().ok()?.port().checked_sub(1)?;
        let companion = DiscoverySocket::new(companion.try_clone().ok()?).ok()?;
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
    pub companion: Arc<UdpSocket>,
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
            return Some(candidate(endpoint, CandidateFlavor::Sip));
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
                let signaling = self.signaling.try_clone().ok()?;
                let browser = self.claim.identity.browser;
                tokio::task::spawn_blocking(move || signaling.send_to(&packet, (browser, 5060)))
                    .await
                    .ok()?
                    .ok()?;
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
        Some(candidate(endpoint, kind))
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

pub(super) fn candidate(endpoint: SocketAddr, kind: CandidateFlavor) -> serde_json::Value {
    serde_json::json!({ "addr": endpoint.ip(), "port": endpoint.port(), "kind": kind, "scope": "public" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_public_odd_mapping_needs_no_companion_grant() {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let gateway_port = socket.local_addr().unwrap().port();
        let retirement = Retirement::new();
        let path = super::super::tests::loopback_path(false);
        let (listener, companion) = pair(&path, &retirement).unwrap();
        let media_port = listener.local_addr().unwrap().port();
        let socket_owner = DiscoverySocket::new(listener).unwrap();
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
        let socket = DiscoverySocket::new(socket).unwrap();
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
        let socket = DiscoverySocket::new(socket).unwrap();
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
