//! Gateway-realm grants for the owned SIP media pair. Only an observed outer
//! allocation may turn an intermediate grant into a public candidate.

use super::*;

#[derive(Clone)]
enum Selected {
    Pcp(pcp::Server),
    NatPmp(pcp::Server, Ipv4Addr),
    Upnp(upnp::ControlUrl, Ipv4Addr),
}

/// Probe without mutation, then acquire one media mapping from the first proven
/// protocol. The caller must retain its socket and own cleanup across cancellation.
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
            return map(
                egress,
                selected,
                internal_port,
                SocketAddr::from((Ipv4Addr::UNSPECIFIED, external_port)),
            )
            .await;
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
    )
    .await
}

async fn map(
    egress: &EgressPath,
    selected: Selected,
    internal: u16,
    suggested: SocketAddr,
) -> Option<Box<Lease>> {
    let schedule = RetransmitSchedule::PRODUCTION;
    let grant = match selected {
        Selected::Pcp(server) => {
            let nonce = random_nonce()?;
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
            .ok()?;
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
            .ok()?;
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
            .ok()?;
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
    Some(grant)
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
