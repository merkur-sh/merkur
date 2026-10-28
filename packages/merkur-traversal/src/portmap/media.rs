//! Gateway-realm grants for the owned SIP media pair. Only an observed outer
//! allocation may turn an intermediate grant into a public candidate.

use super::*;

#[derive(Clone)]
enum Selected {
    Pcp(pcp::Server),
    NatPmp(pcp::Server, Ipv4Addr),
    Upnp(upnp::ControlUrl, Ipv4Addr),
}

enum MapFailure {
    Refused,
    Uncertain,
}

impl From<pcp::Failure> for MapFailure {
    fn from(error: pcp::Failure) -> Self {
        match error {
            pcp::Failure::Result(_) => Self::Refused,
            pcp::Failure::Silent | pcp::Failure::Socket => Self::Uncertain,
        }
    }
}

impl From<upnp::SoapError> for MapFailure {
    fn from(error: upnp::SoapError) -> Self {
        match error {
            upnp::SoapError::Upnp(_) => Self::Refused,
            upnp::SoapError::Transport => Self::Uncertain,
        }
    }
}

/// Probe without mutation, then map through proven protocols in arrival order.
/// Only a definitive refusal permits another protocol to mutate the same tuple.
/// The caller retains its socket and owns cleanup across cancellation.
pub async fn acquire(
    internal_port: u16,
    egress: &EgressPath,
    ports: GatewayPorts,
    schedule: RetransmitSchedule,
) -> Option<Box<Lease>> {
    let gateway = egress.gateway?;
    // Allocate a fresh explicit WAN tuple rather than reopening the URL already
    // offered by the initial SIP request. Browsers retain failed URLs per visit.
    // This is a mapping request, never a probe or an inferred external port.
    let entropy = random_nonce()?;
    let mut external_port = 49152 | (u16::from_be_bytes([entropy[0], entropy[1]]) & 0x3ffe);
    if external_port == internal_port {
        external_port ^= 2;
    }
    let server = pcp::Server {
        gateway: IpAddr::V4(gateway),
        interface: egress.interface_index,
        port: ports.pxp,
    };
    let (sender, mut proofs) = mpsc::channel(2);
    let datagrams = probe_first_hop(egress.local_ipv4, server, schedule, sender);
    let igd = upnp::discover_gateway(egress, ports.ssdp, ports.ssdp_window);
    tokio::pin!(datagrams, igd);
    let (mut datagrams_done, mut closed, mut igd_done) = (false, false, false);
    while !(closed && igd_done) {
        let selected = tokio::select! {
            proof = proofs.recv(), if !closed => match proof {
                Some(DatagramProof::Pcp(server)) => Some(Selected::Pcp(server)),
                Some(DatagramProof::NatPmp { server, external }) => Some(Selected::NatPmp(server, external)),
                None => { closed = true; None }
            },
            () = &mut datagrams, if !datagrams_done => { datagrams_done = true; None },
            found = &mut igd, if !igd_done => {
                igd_done = true;
                match found {
                    upnp::Discovery::Gateway { control, external } => Some(Selected::Upnp(control, external)),
                    upnp::Discovery::Edge(_) | upnp::Discovery::InnerNat | upnp::Discovery::None => None,
                }
            }
        };
        if let Some(selected) = selected {
            match map(
                egress,
                selected,
                internal_port,
                SocketAddr::from((Ipv4Addr::UNSPECIFIED, external_port)),
                schedule,
            )
            .await
            {
                Ok(grant) if !grant.lifetime.is_zero() => return Some(grant),
                Ok(_) | Err(MapFailure::Refused) => {}
                Err(MapFailure::Uncertain) => return None,
            }
        }
    }
    None
}

/// Use the first grant's exact protocol/server/address to acquire its companion.
/// The returned port is checked by the owner; an odd or nonadjacent pair is unused.
pub async fn companion(media: &Lease, internal_port: u16) -> Option<Box<Lease>> {
    let IpAddr::V4(address) = media.external.ip() else {
        return None;
    };
    let egress = EgressPath {
        local_ipv4: media.local_ipv4,
        interface_index: media.interface_index,
        interface_name: String::new(),
        gateway: Some(media.gateway),
    };
    let selected = match &media.inner {
        LeaseHandle::Pcp { server, .. } => Selected::Pcp(*server),
        LeaseHandle::NatPmp { server, .. } => Selected::NatPmp(*server, address),
        LeaseHandle::Upnp { control, .. } => Selected::Upnp(control.clone(), address),
    };
    map(
        &egress,
        selected,
        internal_port,
        SocketAddr::new(media.external.ip(), media.external.port().checked_add(1)?),
        RetransmitSchedule::PRODUCTION,
    )
    .await
    .ok()
}

async fn map(
    egress: &EgressPath,
    selected: Selected,
    internal: u16,
    suggested: SocketAddr,
    schedule: RetransmitSchedule,
) -> Result<Box<Lease>, MapFailure> {
    let grant = match selected {
        Selected::Pcp(server) => {
            let nonce = random_nonce().ok_or(MapFailure::Uncertain)?;
            let mapped = pcp::map_to(
                IpAddr::V4(egress.local_ipv4),
                server,
                internal,
                REQUESTED_LIFETIME_SECS,
                nonce,
                suggested,
                schedule,
            )
            .await
            .map_err(MapFailure::from)?;
            let mut grant = lease(
                egress,
                Ipv4Addr::UNSPECIFIED,
                mapped.assigned_external_port,
                Protocol::Pcp,
                mapped.lifetime_secs,
                mapped.epoch,
                LeaseHandle::Pcp {
                    server,
                    nonce,
                    internal_port: internal,
                },
            );
            grant
                .external
                .set_ip(pcp::unmapped(mapped.assigned_external));
            grant
        }
        Selected::NatPmp(server, external) => {
            let mapped = natpmp::map_to(
                egress.local_ipv4,
                server,
                internal,
                suggested.port(),
                REQUESTED_LIFETIME_SECS,
                schedule,
            )
            .await
            .map_err(MapFailure::from)?;
            lease(
                egress,
                external,
                mapped.external_port,
                Protocol::NatPmp,
                mapped.lifetime_secs,
                mapped.epoch,
                LeaseHandle::NatPmp {
                    server,
                    internal_port: internal,
                },
            )
        }
        Selected::Upnp(control, external) => {
            let mapped = upnp::add_port_mapping(
                &control,
                egress.local_ipv4,
                internal,
                suggested.port(),
                REQUESTED_LIFETIME_SECS,
            )
            .await
            .map_err(MapFailure::from)?;
            lease(
                egress,
                external,
                mapped.external_port,
                Protocol::Upnp,
                upnp_cadence_secs(mapped.lease_secs),
                0,
                LeaseHandle::Upnp {
                    control,
                    external_port: mapped.external_port,
                    internal_port: internal,
                    client: egress.local_ipv4,
                    lease_secs: mapped.lease_secs,
                },
            )
        }
    };
    Ok(grant)
}

/// Both grants name one actual even RTP/RTCP allocation in the same realm.
pub fn compatible(media: &Lease, companion: &Lease) -> bool {
    media.external.port() != 0
        && media.external.port().is_multiple_of(2)
        && media.external.ip() == companion.external.ip()
        && media.external.port().checked_add(1) == Some(companion.external.port())
        && media.expires_at > Instant::now()
        && companion.expires_at > Instant::now()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_present_protocols_map_refusal_does_not_discard_another_proven_protocol() {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let router = tokio::spawn(async move {
            let mut buffer = [0; 100];
            let mut external_request = None;
            let mut refused = false;
            loop {
                let (length, from) = socket.recv_from(&mut buffer).await.unwrap();
                let packet = &buffer[..length];
                let response = if packet[0] == pcp::VERSION {
                    let mut answer = vec![0; 24];
                    answer[0] = pcp::VERSION;
                    answer[1] = packet[1] | 0x80;
                    if packet[1] == 1 {
                        answer[3] = 2;
                        refused = true;
                    }
                    answer
                } else if length == 2 {
                    external_request = Some(from);
                    Vec::new()
                } else {
                    assert!(refused, "PCP refusal precedes any NAT-PMP mutation");
                    let lifetime = u32::from_be_bytes(packet[8..12].try_into().unwrap());
                    let response = natpmp::tests::map_answer(packet, lifetime);
                    socket.send_to(&response, from).await.unwrap();
                    if lifetime == 0 {
                        return;
                    }
                    continue;
                };
                if !response.is_empty() {
                    socket.send_to(&response, from).await.unwrap();
                }
                if refused && let Some(client) = external_request.take() {
                    let answer = natpmp::tests::external_answer(5, Ipv4Addr::LOCALHOST);
                    socket.send_to(&answer, client).await.unwrap();
                }
            }
        });
        let egress = EgressPath {
            local_ipv4: Ipv4Addr::LOCALHOST,
            interface_index: 0,
            interface_name: "test".into(),
            gateway: Some(Ipv4Addr::LOCALHOST),
        };
        let ports = GatewayPorts {
            pxp: port,
            ..GatewayPorts::STANDARD
        };
        let acquired = acquire(42000, &egress, ports, RetransmitSchedule::DELETE).await;
        assert!(
            acquired.is_some(),
            "a refused PCP map must leave NAT-PMP eligible"
        );
        let acquired = acquired.unwrap();
        assert_eq!(acquired.protocol, Protocol::NatPmp);
        assert!(release(*acquired).await);
        router.await.unwrap();
    }

    #[tokio::test]
    async fn a_gateway_pair_keeps_its_realm_and_granted_ports_across_renewal_and_delete() {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let router = tokio::spawn(async move {
            let mut buffer = [0; 100];
            let mut mapped = std::collections::HashMap::new();
            let mut operations = Vec::new();
            loop {
                let (len, from) = socket.recv_from(&mut buffer).await.unwrap();
                let packet = &buffer[..len];
                let response = if packet[0] == pcp::VERSION {
                    vec![0, 0x80, 0, 1, 0, 0, 0, 0]
                } else if packet.len() == 2 {
                    natpmp::tests::external_answer(5, "100.64.0.2".parse().unwrap()).to_vec()
                } else {
                    let inside = u16::from_be_bytes(packet[4..6].try_into().unwrap());
                    let outside = u16::from_be_bytes(packet[6..8].try_into().unwrap());
                    let life = u32::from_be_bytes(packet[8..12].try_into().unwrap());
                    assert!(matches!(inside, 42000 | 42001));
                    if let Some(prior) = mapped.insert(inside, outside) {
                        assert_eq!(prior, outside);
                    }
                    if inside == 42000 {
                        assert!(outside.is_multiple_of(2));
                        assert_ne!(outside, inside);
                    }
                    if inside == 42001 {
                        assert_eq!(outside, mapped[&42000] + 1);
                    }
                    operations.push((inside, outside, life));
                    natpmp::tests::map_answer(packet, if life == 0 { 0 } else { 120 }).to_vec()
                };
                socket.send_to(&response, from).await.unwrap();
                if operations.iter().filter(|(_, _, life)| *life == 0).count() == 2 {
                    return operations;
                }
            }
        });
        let egress = EgressPath {
            local_ipv4: Ipv4Addr::LOCALHOST,
            interface_index: 0,
            interface_name: "test".into(),
            gateway: Some(Ipv4Addr::LOCALHOST),
        };
        let ports = GatewayPorts {
            pxp: port,
            pcp_anycast_v4: None,
            pcp_anycast_v6: None,
            ..GatewayPorts::STANDARD
        };
        let mut first = acquire(42000, &egress, ports, RetransmitSchedule::DELETE)
            .await
            .unwrap();
        let mut second = companion(&first, 42001).await.unwrap();
        assert_eq!(first.external.ip(), "100.64.0.2".parse::<IpAddr>().unwrap());
        assert!(compatible(&first, &second));
        assert!(renew(&mut first).await);
        assert!(renew(&mut second).await);
        assert!(compatible(&first, &second));
        assert!(release(*first).await);
        assert!(release(*second).await);
        assert_eq!(router.await.unwrap().len(), 6);
    }
}
