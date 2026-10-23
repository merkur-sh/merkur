use super::super::{MappingCycle, PinholeOutcome};
use super::*;
use crate::{
    WtMaintenanceCompletion, WtMaintenanceKind, WtMaintenanceOwner, WtMaintenanceResult,
    drain_wt_maintenance,
};
use portmap::upnp::ControlUrl;

const WAN_IPV6_FIREWALL_1: &str = "urn:schemas-upnp-org:service:WANIPv6FirewallControl:1";
use std::net::Ipv6Addr;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

struct Request {
    action: String,
    body: String,
    response: oneshot::Sender<(u16, String)>,
}

struct Gateway {
    control: ControlUrl,
    requests: mpsc::UnboundedReceiver<Request>,
    task: JoinHandle<()>,
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Gateway {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("[::1]:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests, receiver) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            loop {
                let (stream, peer) = listener.accept().await.unwrap();
                assert_eq!(peer.ip(), IpAddr::V6(Ipv6Addr::LOCALHOST));
                let mut stream = BufReader::new(stream);
                let mut action = String::new();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    assert_ne!(stream.read_line(&mut line).await.unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.strip_prefix("Content-Length: ") {
                        length = value.trim().parse().unwrap();
                    }
                    if let Some(value) = line.strip_prefix("SOAPAction: ") {
                        action = value
                            .trim()
                            .trim_matches('"')
                            .rsplit('#')
                            .next()
                            .unwrap()
                            .into();
                    }
                }
                assert!(length <= 4096);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                let (response, reply) = oneshot::channel();
                if requests
                    .send(Request {
                        action,
                        body: String::from_utf8(body).unwrap(),
                        response,
                    })
                    .is_err()
                {
                    return;
                }
                let (status, body) = reply.await.unwrap();
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream
                    .get_mut()
                    .write_all(response.as_bytes())
                    .await
                    .unwrap();
                stream.get_mut().shutdown().await.unwrap();
            }
        });
        Self {
            control: ControlUrl {
                address,
                host: address.to_string(),
                path: "/ctl/IP6FC".into(),
                service_type: WAN_IPV6_FIREWALL_1,
                source: Some(IpAddr::V6(Ipv6Addr::LOCALHOST)),
            },
            requests: receiver,
            task,
        }
    }

    async fn next(&mut self, action: &str) -> Request {
        let request = tokio::time::timeout(Duration::from_secs(3), self.requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(request.action, action);
        request
    }
}

fn socket() -> (Arc<DiscoverySocket>, SocketAddr) {
    let raw = std::net::UdpSocket::bind("[::1]:0").unwrap();
    raw.set_nonblocking(true).unwrap();
    let address = raw.local_addr().unwrap();
    (DiscoverySocket::new(raw).unwrap(), address)
}

async fn acquire(factory: Factory, socket: Arc<DiscoverySocket>, control: ControlUrl) -> Pinhole {
    use wtransport::quinn::AsyncUdpSocket;
    let port = socket.local_addr().unwrap().port();
    let reservation = factory
        .reserve(IpAddr::V6(Ipv6Addr::LOCALHOST), port, socket)
        .unwrap();
    let path = super::super::egress::EgressPath6 {
        local: Ipv6Addr::LOCALHOST,
        interface_index: 0,
        interface_name: "loopback".into(),
        gateway: Some(Ipv6Addr::LOCALHOST),
    };
    let pinhole = portmap::open_upnp_pinhole(&path, Ipv6Addr::LOCALHOST, control, port)
        .await
        .unwrap();
    factory.pinhole(*pinhole, reservation)
}

fn acknowledge(request: Request) {
    let body = if request.action == "AddPinhole" {
        "<UniqueID>77</UniqueID>"
    } else {
        ""
    };
    request.response.send((200, body.into())).unwrap();
}

fn completion(pinhole: Pinhole) -> WtMaintenanceCompletion<WtMaintenanceResult> {
    WtMaintenanceCompletion {
        generation: 1,
        kind: WtMaintenanceKind::Mapping,
        result: WtMaintenanceResult::Mapping(MappingCycle {
            lease: super::super::LeaseOutcome::Deferred,
            pinhole: PinholeOutcome::Opened(pinhole),
            egress: None,
        }),
    }
}

#[tokio::test]
async fn retained_provider_and_renewed_snapshot_share_one_acknowledged_retirement() {
    let mut gateway = Gateway::start().await;
    let mut owner = Owner::new();
    let factory = owner.factory();
    let (socket, address) = socket();
    let acquiring = tokio::spawn(acquire(
        factory.clone(),
        socket.clone(),
        gateway.control.clone(),
    ));
    acknowledge(gateway.next("AddPinhole").await);
    let grant = acquiring.await.unwrap();
    let provider = grant.pin();
    let reset = grant.clone();
    let renewing = tokio::spawn(async move {
        let _renewing = grant.renewing().unwrap();
        let mut snapshot = (*grant).clone();
        assert!(portmap::renew_pinhole(&mut snapshot).await);
        grant.renewed(snapshot)
    });
    let update = gateway.next("UpdatePinhole").await;
    reset.forget();
    assert!(
        reset.is_owned(),
        "an in-flight RPC retains its deletion context"
    );
    drop(reset);
    assert!(update.body.contains("<UniqueID>77</UniqueID>"));
    acknowledge(update);
    let renewed = renewing.await.unwrap();
    drop(renewed);
    assert!(
        factory
            .reserve(address.ip(), address.port(), socket.clone())
            .is_none()
    );
    drop(provider);
    let deletion = gateway.next("DeletePinhole").await;
    assert!(deletion.body.contains("<UniqueID>77</UniqueID>"));
    assert!(
        factory
            .reserve(address.ip(), address.port(), socket.clone())
            .is_none()
    );
    acknowledge(deletion);
    owner.retired().await;
    assert!(
        factory
            .reserve(address.ip(), address.port(), socket)
            .is_some()
    );
    drop(factory);
    owner.shutdown().await.unwrap();
    assert!(gateway.requests.try_recv().is_err(), "exactly one Delete");
}

#[tokio::test]
async fn a_stale_unpublished_mapping_completion_still_deletes_its_grant() {
    let mut gateway = Gateway::start().await;
    let owner = Owner::new();
    let factory = owner.factory();
    let (socket, _) = socket();
    let acquiring = tokio::spawn(acquire(factory.clone(), socket, gateway.control.clone()));
    acknowledge(gateway.next("AddPinhole").await);
    let grant = acquiring.await.unwrap();
    assert!(
        WtMaintenanceOwner::default()
            .accept(completion(grant))
            .is_none()
    );
    let deletion = gateway.next("DeletePinhole").await;
    acknowledge(deletion);
    drop(factory);
    owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_joins_an_inflight_add_and_drains_a_previously_reserved_completion() {
    let mut gateway = Gateway::start().await;
    let owner = Owner::new();
    let factory = owner.factory();
    let (socket, address) = socket();
    let (sender, mut receiver) = mpsc::channel(1);
    let permit = sender.reserve_owned().await.unwrap();
    let control = gateway.control.clone();
    let producer = tokio::spawn(async move {
        let grant = acquire(factory, socket, control).await;
        permit.send(completion(grant));
    });
    let add = gateway.next("AddPinhole").await;
    let draining = tokio::spawn(async move {
        drain_wt_maintenance(Some((1, producer)), true, &mut receiver).await;
    });
    acknowledge(add);
    draining.await.unwrap();
    let deleting = gateway.next("DeletePinhole").await;
    let shutdown = tokio::spawn(owner.shutdown());
    assert!(
        std::net::UdpSocket::bind(address).is_err(),
        "Delete retains the UDP tuple"
    );
    assert!(!shutdown.is_finished(), "cleanup waits for the gateway ACK");
    acknowledge(deleting);
    shutdown.await.unwrap().unwrap();
    assert!(std::net::UdpSocket::bind(address).is_ok());
}

#[tokio::test]
async fn an_unacknowledged_delete_never_reopens_the_allocation_lane() {
    let mut gateway = Gateway::start().await;
    let owner = Owner::new();
    let factory = owner.factory();
    let (socket, address) = socket();
    let acquiring = tokio::spawn(acquire(
        factory.clone(),
        socket.clone(),
        gateway.control.clone(),
    ));
    acknowledge(gateway.next("AddPinhole").await);
    drop(acquiring.await.unwrap());
    let deletion = gateway.next("DeletePinhole").await;
    deletion
        .response
        .send((
            500,
            "<UPnPError><errorCode>606</errorCode></UPnPError>".into(),
        ))
        .unwrap();
    // The owner joins the response before reporting failure; neither timeout
    // nor refusal is allocation retirement authority.
    assert!(
        factory
            .reserve(address.ip(), address.port(), socket)
            .is_none()
    );
    drop(factory);
    assert!(owner.shutdown().await.is_err());
}

#[tokio::test]
async fn a_retained_ipv4_lane_does_not_block_an_independent_ipv6_lane() {
    let mut owner = Owner::new();
    let factory = owner.factory();
    let (socket, address) = socket();
    let v4 = factory
        .reserve("127.0.0.1".parse().unwrap(), address.port(), socket.clone())
        .unwrap();
    assert!(
        factory
            .reserve("127.0.0.1".parse().unwrap(), address.port(), socket.clone())
            .is_none()
    );
    let v6 = factory
        .reserve(address.ip(), address.port(), socket)
        .unwrap();
    drop(v6);
    assert!(
        !owner.retired.has_changed().unwrap(),
        "an unrelated unsupported family cannot rearm the retained IPv4 allocation"
    );
    drop(v4);
    owner.retired().await;
    drop(factory);
    owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn authenticated_direct_provider_retains_its_actual_ipv6_grant() {
    use wtransport::quinn::AsyncUdpSocket;
    let mut gateway = Gateway::start().await;
    let mut owner = Owner::new();
    let factory = owner.factory();
    let (config, cert, side, socket) = super::super::build_server_config_owning_socket(0).unwrap();
    let port = socket.local_addr().unwrap().port();
    let source = IpAddr::V6(Ipv6Addr::LOCALHOST);
    let endpoint = wtransport::Endpoint::server_with_socket(config, socket.clone()).unwrap();
    let client = wtransport::Endpoint::client(
        wtransport::ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(cert.cert_hash)])
            .build(),
    )
    .unwrap();
    let (server, connected) = tokio::join!(
        async {
            endpoint
                .accept()
                .await
                .await
                .unwrap()
                .accept()
                .await
                .unwrap()
        },
        client.connect(format!("https://[::1]:{port}"))
    );
    let connected = connected.unwrap();
    let acquiring = tokio::spawn(acquire(
        factory.clone(),
        socket.clone(),
        gateway.control.clone(),
    ));
    acknowledge(gateway.next("AddPinhole").await);
    let grant = acquiring.await.unwrap();
    let mut state = super::super::WebTransportState::new(
        cert,
        port,
        Vec::new(),
        super::super::pairing::NatSignature {
            public_ip: None,
            nat_type: super::super::pairing::NatTypeLabel::from(
                super::super::stun::NatMapping::Unknown,
            ),
            hairpin: false,
        },
        super::super::stun::NatMapping::Unknown,
        None,
    );
    state.v6_pinhole = Some(grant);
    let session = Arc::new(server);
    let (senders, _lanes) = super::super::captured_lanes();
    state.sessions.insert("browser".into(), session.clone());
    state.peer_connections.insert(
        "browser".into(),
        crate::network::peer::ChannelPeerConnection {
            senders,
            connection_id: 9,
        },
    );
    state.connection_listeners.insert(9, 0);
    let mut provider = super::super::DirectSession::from_connection(session.clone());
    provider.retain_router_grant(&state, "browser");
    state.v6_pinhole = None;
    assert!(factory.reserve(source, port, socket.clone()).is_none());
    let mut registry = crate::PeerRegistry::new();
    let mut parked = crate::connection::PeerDisplayState::new(
        "browser".into(),
        crate::connection::PeerTransport::Edge,
    );
    parked.direct_session = Some(provider);
    drop(registry.parked.park(parked, 0.0));
    crate::retire_router_providers(&mut registry);
    assert_eq!(
        registry.parked.len(),
        1,
        "display continuity remains parked"
    );
    acknowledge(gateway.next("DeletePinhole").await);
    owner.retired().await;
    let acquiring = tokio::spawn(acquire(
        factory.clone(),
        socket.clone(),
        gateway.control.clone(),
    ));
    acknowledge(gateway.next("AddPinhole").await);
    state.v6_pinhole = Some(acquiring.await.unwrap());
    state.connection_listeners.insert(9, 42);
    let mut helper = super::super::DirectSession::from_connection(session);
    helper.retain_router_grant(&state, "browser");
    state.v6_pinhole = None;
    acknowledge(gateway.next("DeletePinhole").await);
    drop(helper);
    drop(factory);
    owner.shutdown().await.unwrap();
    connected.close(wtransport::VarInt::from_u32(0), b"test-finished");
    drop((endpoint, client, side));
}

async fn acquire_v4(factory: &Factory, socket: Arc<DiscoverySocket>, port: u16) -> Option<Lease> {
    let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let gateway_port = udp.local_addr().unwrap().port();
    let gateway = tokio::spawn(async move {
        for opcode in [0, 1] {
            let mut request = [0; 100];
            let client = loop {
                let (_, client) = udp.recv_from(&mut request).await.unwrap();
                if request[..2] == [2, opcode] {
                    break client;
                }
            };
            let mut response = vec![0; if opcode == 0 { 24 } else { 60 }];
            response[0] = 2;
            response[1] = opcode | 0x80;
            response[8..12].copy_from_slice(&10u32.to_be_bytes());
            if opcode == 1 {
                response[4..8].copy_from_slice(&request[4..8]);
                response[24..42].copy_from_slice(&request[24..42]);
                response[42..44].copy_from_slice(&port.to_be_bytes());
                let external = "203.0.113.7"
                    .parse::<std::net::Ipv4Addr>()
                    .unwrap()
                    .to_ipv6_mapped();
                response[44..60].copy_from_slice(&external.octets());
            }
            udp.send_to(&response, client).await.unwrap();
        }
    });
    let path = super::super::egress::EgressPath {
        local_ipv4: std::net::Ipv4Addr::LOCALHOST,
        interface_index: 0,
        interface_name: "loopback".into(),
        gateway: Some(std::net::Ipv4Addr::LOCALHOST),
    };
    let reservation = factory
        .reserve(IpAddr::V4(path.local_ipv4), port, socket)
        .unwrap();
    let mut ports = portmap::GatewayPorts::STANDARD;
    ports.pxp = gateway_port;
    ports.ssdp = 1;
    ports.ssdp_window = Duration::from_millis(10);
    ports.pcp_anycast_v4 = None;
    let portmap::Outcome::Mapped(lease) = portmap::acquire_with(
        port,
        Some(&path),
        Some("203.0.113.7".parse().unwrap()),
        portmap::RetransmitSchedule {
            initial: Duration::from_millis(250),
            max_interval: Duration::from_millis(250),
            attempts: 1,
        },
        ports,
    )
    .await
    else {
        return None;
    };
    gateway.await.unwrap();
    Some(factory.lease(*lease, reservation))
}

#[tokio::test]
async fn a_reset_retires_only_the_grant_owned_by_the_proven_announcer() {
    use wtransport::quinn::AsyncUdpSocket;
    let mut gateway = Gateway::start().await;
    let owner = Owner::new();
    let factory = owner.factory();
    let (config, cert, side, socket) = super::super::build_server_config_owning_socket(0).unwrap();
    drop(config);
    let port = socket.local_addr().unwrap().port();
    let v4 = acquire_v4(&factory, socket.clone(), port)
        .await
        .expect("the loopback PCP responder grants the mapping");
    let acquiring = tokio::spawn(acquire(
        factory.clone(),
        socket.clone(),
        gateway.control.clone(),
    ));
    acknowledge(gateway.next("AddPinhole").await);
    let v6 = acquiring.await.unwrap();
    let mut state = super::super::WebTransportState::new(
        cert,
        port,
        Vec::new(),
        super::super::pairing::NatSignature {
            public_ip: None,
            nat_type: super::super::pairing::NatTypeLabel::from(
                super::super::stun::NatMapping::Unknown,
            ),
            hairpin: false,
        },
        super::super::stun::NatMapping::Unknown,
        None,
    );
    state.port_lease = Some(v4);
    state.v6_pinhole = Some(v6);
    let mut source = super::super::egress::EgressPath {
        local_ipv4: std::net::Ipv4Addr::LOCALHOST,
        interface_index: 1,
        interface_name: "loopback".into(),
        gateway: Some(std::net::Ipv4Addr::LOCALHOST),
    };
    let announcement = portmap::announce::Announcement {
        epoch: 9,
        external: None,
    };
    assert!(!crate::forget_announced_router_grant(
        &state,
        &source,
        &announcement
    ));
    assert!(state.port_lease.as_ref().unwrap().is_owned());
    source.interface_index = 0;
    assert!(crate::forget_announced_router_grant(
        &state,
        &source,
        &announcement
    ));
    assert!(!state.port_lease.as_ref().unwrap().is_owned());
    assert!(
        state.v6_pinhole.as_ref().unwrap().is_owned(),
        "an IPv4 announcement cannot retire the IPv6 allocation"
    );
    assert!(
        factory
            .reserve(IpAddr::V4(source.local_ipv4), port, socket)
            .is_some()
    );
    drop(state);
    acknowledge(gateway.next("DeletePinhole").await);
    drop(factory);
    owner.shutdown().await.unwrap();
    drop(side);
}
