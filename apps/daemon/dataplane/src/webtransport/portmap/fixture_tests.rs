//! The acquisition path, driven against gateways that actually answer.
//!
//! The predecessor's send path was measured against a real gateway; its
//! *response parsing* had never once executed, because no gateway in the fleet
//! ever replied. So every protocol here is exercised against a fake first hop
//! on loopback that speaks the wire format back — PCP and NAT-PMP on one UDP
//! socket, SSDP on another, and an IGD over HTTP — in every order the three can
//! answer. Deterministic, no network, no container.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex};

use tokio::net::UdpSocket;

use super::super::egress::EgressPath6;
use super::*;

/// The STUN-observed public address every test verifies against.
const REFLEXIVE: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);
/// A gateway that is not the edge NAT reports this instead: a CGN or an outer
/// router's WAN-side address.
const INNER: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 9);
const PORT: u16 = 44_433;

fn fast() -> RetransmitSchedule {
    RetransmitSchedule {
        initial: Duration::from_millis(40),
        max_interval: Duration::from_millis(80),
        attempts: 2,
    }
}

fn loopback_egress() -> EgressPath {
    EgressPath {
        local_ipv4: Ipv4Addr::LOCALHOST,
        interface_index: 0,
        interface_name: "test".to_string(),
        gateway: Some(Ipv4Addr::LOCALHOST),
    }
}

async fn bound() -> (Arc<UdpSocket>, u16) {
    let socket = UdpSocket::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))
        .await
        .expect("bind");
    let port = socket.local_addr().expect("addr").port();
    (Arc::new(socket), port)
}

/// What the fake first hop speaks on its PCP/NAT-PMP port.
#[derive(Clone, Copy, Default)]
struct FirstHop {
    /// PCP present, assigning MAPs this external address.
    pcp: Option<Ipv4Addr>,
    /// NAT-PMP present, reporting this external address.
    natpmp: Option<Ipv4Addr>,
}

type Recorded = Arc<Mutex<Vec<Vec<u8>>>>;

/// A first hop that answers as `behaviour` says and records every request.
/// Neither protocol present means silence, like a gateway with no server.
async fn fake_first_hop(behaviour: FirstHop) -> (u16, Recorded) {
    let (socket, port) = bound().await;
    let seen: Recorded = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);
    tokio::spawn(async move {
        let mut buf = [0u8; 1500];
        loop {
            let Ok((len, from)) = socket.recv_from(&mut buf).await else {
                return;
            };
            let request = buf[..len].to_vec();
            recorded.lock().unwrap().push(request.clone());
            let reply: Option<Vec<u8>> = match (request.first(), request.get(1)) {
                // PCP ANNOUNCE.
                (Some(2), Some(0)) => match (behaviour.pcp, behaviour.natpmp) {
                    (Some(_), _) => Some(pcp::tests::announce_response(0, 9).to_vec()),
                    // A NAT-PMP-only server refuses PCP with version 0.
                    (None, Some(_)) => Some(vec![0, 0x80, 0, 1, 0, 0, 0, 0]),
                    (None, None) => None,
                },
                // PCP MAP, echoing the lifetime so a delete reads as one.
                (Some(2), Some(1)) => behaviour.pcp.map(|external| {
                    let nonce: [u8; 12] = request[24..36].try_into().unwrap();
                    let lifetime = u32::from_be_bytes(request[4..8].try_into().unwrap());
                    let port = u16::from_be_bytes([request[40], request[41]]);
                    pcp::tests::map_response(&nonce, port, 0, lifetime, IpAddr::V4(external))
                        .to_vec()
                }),
                // NAT-PMP external-address request.
                (Some(0), Some(0)) => match (behaviour.natpmp, behaviour.pcp) {
                    (Some(external), _) => {
                        Some(natpmp::tests::external_answer(3, external).to_vec())
                    }
                    // A PCP-only server refuses NAT-PMP with version 2.
                    (None, Some(_)) => {
                        let mut refusal = pcp::tests::announce_response(1, 9).to_vec();
                        refusal[3] = pcp::RESULT_UNSUPP_VERSION;
                        Some(refusal)
                    }
                    (None, None) => None,
                },
                // NAT-PMP UDP map.
                (Some(0), Some(1)) => behaviour.natpmp.map(|_| {
                    let lifetime = u32::from_be_bytes(request[8..12].try_into().unwrap());
                    natpmp::tests::map_answer(&request, lifetime).to_vec()
                }),
                _ => None,
            };
            if let Some(reply) = reply {
                let _ = socket.send_to(&reply, from).await;
            }
        }
    });
    (port, seen)
}

fn igd_description() -> String {
    r#"<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<serviceList><service>
<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<controlURL>/ctl/IPConn</controlURL>
</service></serviceList>
</device></root>"#
        .to_string()
}

/// An IGD reporting `external`, answering SSDP on the returned port. Its SOAP
/// actions are recorded in order.
async fn fake_igd(external: Ipv4Addr) -> (u16, Arc<Mutex<Vec<(String, String)>>>) {
    let (http, seen) = upnp::tests::fake_igd(igd_description(), move |action, _| match action {
        "GetExternalIPAddress" => (
            200,
            format!("<NewExternalIPAddress>{external}</NewExternalIPAddress>"),
        ),
        _ => (200, String::new()),
    })
    .await;
    let (ssdp, port) = bound().await;
    tokio::spawn(async move {
        let mut buf = [0u8; 1500];
        loop {
            let Ok((_, from)) = ssdp.recv_from(&mut buf).await else {
                return;
            };
            let answer = format!(
                "HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://{http}/rootDesc.xml\r\n\r\n"
            );
            let _ = ssdp.send_to(answer.as_bytes(), from).await;
        }
    });
    (port, seen)
}

/// An SSDP port that never answers.
async fn silent_ssdp() -> (u16, Arc<UdpSocket>) {
    let (socket, port) = bound().await;
    (port, socket)
}

fn ports(pxp: u16, ssdp: u16) -> GatewayPorts {
    GatewayPorts {
        pxp,
        ssdp,
        ssdp_window: Duration::from_millis(400),
    }
}

fn soap_actions(seen: &Mutex<Vec<(String, String)>>) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|(action, _)| action.clone())
        .collect()
}

fn map_requests(seen: &Recorded) -> Vec<Vec<u8>> {
    seen.lock()
        .unwrap()
        .iter()
        .filter(|request| request.get(1) == Some(&1))
        .cloned()
        .collect()
}

async fn acquire_against(behaviour: FirstHop, ssdp: u16, schedule: RetransmitSchedule) -> Outcome {
    let (pxp, _) = fake_first_hop(behaviour).await;
    acquire_with(
        PORT,
        Some(&loopback_egress()),
        Some(IpAddr::V4(REFLEXIVE)),
        schedule,
        ports(pxp, ssdp),
    )
    .await
}

fn mapped(outcome: Outcome) -> Box<Lease> {
    match outcome {
        Outcome::Mapped(lease) => lease,
        other => panic!("expected a lease, got {}", other.metric_key()),
    }
}

#[tokio::test]
async fn a_natpmp_only_gateway_maps_with_natpmp_on_the_verified_address() {
    let (ssdp, _silent) = silent_ssdp().await;
    let lease = mapped(
        acquire_against(
            FirstHop {
                natpmp: Some(REFLEXIVE),
                ..FirstHop::default()
            },
            ssdp,
            fast(),
        )
        .await,
    );
    assert_eq!(lease.protocol, Protocol::NatPmp);
    assert_eq!(lease.external, SocketAddr::new(IpAddr::V4(REFLEXIVE), PORT));
}

#[tokio::test]
async fn a_pcp_only_gateway_maps_with_pcp() {
    let (ssdp, _silent) = silent_ssdp().await;
    let lease = mapped(
        acquire_against(
            FirstHop {
                pcp: Some(REFLEXIVE),
                ..FirstHop::default()
            },
            ssdp,
            fast(),
        )
        .await,
    );
    assert_eq!(lease.protocol, Protocol::Pcp);
    assert_eq!(lease.external, SocketAddr::new(IpAddr::V4(REFLEXIVE), PORT));
}

/// A PCP gateway assigning an address other than the reflexive one is an
/// inner NAT: the lease is not published, and the mapping it made is deleted
/// under the same nonce.
#[tokio::test]
async fn a_pcp_gateway_behind_another_nat_is_inner_and_its_mapping_is_deleted() {
    let (ssdp, _silent) = silent_ssdp().await;
    let (pxp, seen) = fake_first_hop(FirstHop {
        pcp: Some(INNER),
        ..FirstHop::default()
    })
    .await;
    let outcome = acquire_with(
        PORT,
        Some(&loopback_egress()),
        Some(IpAddr::V4(REFLEXIVE)),
        fast(),
        ports(pxp, ssdp),
    )
    .await;
    assert!(matches!(outcome, Outcome::InnerNat));
    assert_eq!(outcome.metric_key(), "gateway:inner_nat");
    let maps = map_requests(&seen);
    assert_eq!(maps.len(), 2, "one MAP, one delete");
    assert_eq!(&maps[0][24..36], &maps[1][24..36], "the delete names the same nonce");
    assert_eq!(&maps[1][4..8], &[0, 0, 0, 0], "lifetime zero deletes");
}

/// NAT-PMP says its external address before anything is mapped, so an inner
/// NAT is refused without creating a mapping at all.
#[tokio::test]
async fn a_natpmp_gateway_behind_another_nat_is_inner_and_nothing_is_mapped() {
    let (ssdp, _silent) = silent_ssdp().await;
    let (pxp, seen) = fake_first_hop(FirstHop {
        natpmp: Some(INNER),
        ..FirstHop::default()
    })
    .await;
    let outcome = acquire_with(
        PORT,
        Some(&loopback_egress()),
        Some(IpAddr::V4(REFLEXIVE)),
        fast(),
        ports(pxp, ssdp),
    )
    .await;
    assert!(matches!(outcome, Outcome::InnerNat));
    assert!(map_requests(&seen).is_empty());
}

/// A gateway that speaks only UPnP maps after one SSDP and one HTTP exchange,
/// not after the datagram protocols' schedule has drawn silence; and it is
/// asked for its external address before it is asked to map.
#[tokio::test]
async fn a_upnp_only_gateway_maps_before_the_datagram_schedule_ends() {
    let (ssdp, seen) = fake_igd(REFLEXIVE).await;
    let long = RetransmitSchedule {
        initial: Duration::from_secs(2),
        max_interval: Duration::from_secs(4),
        attempts: 6,
    };
    let started = Instant::now();
    let lease = mapped(acquire_against(FirstHop::default(), ssdp, long).await);
    assert!(
        started.elapsed() < long.initial,
        "UPnP waited on the datagram schedule: {:?}",
        started.elapsed()
    );
    assert_eq!(lease.protocol, Protocol::Upnp);
    assert_eq!(lease.external, SocketAddr::new(IpAddr::V4(REFLEXIVE), PORT));
    assert_eq!(
        soap_actions(&seen),
        ["GetExternalIPAddress", "AddPortMapping"]
    );
}

#[tokio::test]
async fn a_upnp_gateway_behind_another_nat_is_never_asked_to_map() {
    let (ssdp, seen) = fake_igd(INNER).await;
    let outcome = acquire_against(FirstHop::default(), ssdp, fast()).await;
    assert!(matches!(outcome, Outcome::InnerNat));
    assert_eq!(soap_actions(&seen), ["GetExternalIPAddress"]);
}

/// With all three present, exactly one protocol creates a mapping: miniupnpd
/// serves them from one table, and one's delete would remove another's lease.
#[tokio::test]
async fn only_the_first_proven_protocol_maps_when_all_three_are_present() {
    let (ssdp, igd) = fake_igd(REFLEXIVE).await;
    let (pxp, first_hop) = fake_first_hop(FirstHop {
        pcp: Some(REFLEXIVE),
        natpmp: Some(REFLEXIVE),
    })
    .await;
    let lease = mapped(
        acquire_with(
            PORT,
            Some(&loopback_egress()),
            Some(IpAddr::V4(REFLEXIVE)),
            fast(),
            ports(pxp, ssdp),
        )
        .await,
    );
    assert_ne!(lease.protocol, Protocol::Upnp, "a datagram answer lands first");
    assert_eq!(map_requests(&first_hop).len(), 1, "one datagram MAP, no second protocol");
    assert!(!soap_actions(&igd).contains(&"AddPortMapping".to_string()));
}

#[tokio::test]
async fn no_reflexive_address_reports_not_attempted() {
    let outcome = acquire(PORT, Some(&loopback_egress()), None).await;
    assert!(matches!(
        outcome,
        Outcome::NotAttempted(SkipReason::ReflexiveUnknown)
    ));
    assert_eq!(outcome.metric_key(), "skipped:no_reflexive");
}

/// A gateway that is simply not there must produce `Unsupported`, and must do
/// it in bounded time — both when it blackholes (TEST-NET-1) and when it
/// refuses the port outright.
#[tokio::test]
async fn a_silent_or_refusing_gateway_is_unsupported_and_bounded() {
    let (ssdp, _silent) = silent_ssdp().await;
    let blackholed = EgressPath {
        gateway: Some(Ipv4Addr::new(192, 0, 2, 1)),
        ..loopback_egress()
    };
    let refused_port = {
        let (socket, port) = bound().await;
        drop(socket);
        port
    };
    for (egress, pxp) in [(blackholed, PXP_PORT), (loopback_egress(), refused_port)] {
        let started = Instant::now();
        let outcome = acquire_with(
            PORT,
            Some(&egress),
            Some(IpAddr::V4(REFLEXIVE)),
            fast(),
            ports(pxp, ssdp),
        )
        .await;
        assert!(
            matches!(outcome, Outcome::Unsupported),
            "a gateway that never answers is unsupported, not a skip: {}",
            outcome.metric_key()
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}

/// No first hop means no request was sent, and that must be reportable as such.
///
/// The predecessor returned here through a bare `?` placed *before* its first
/// log line, so two of three protocols could be disabled on any split-tunnel or
/// multi-homed host with no trace in any log, metric or span — and the report
/// recorded the same `false` a refusing gateway produces.
#[tokio::test]
async fn no_gateway_reports_not_attempted_rather_than_unsupported() {
    let egress = EgressPath {
        gateway: None,
        ..loopback_egress()
    };
    let outcome = acquire(PORT, Some(&egress), Some(IpAddr::V4(REFLEXIVE))).await;
    assert!(
        matches!(outcome, Outcome::NotAttempted(SkipReason::NoGateway)),
        "a missing first hop is a routing fact, not a protocol verdict"
    );
    assert_eq!(outcome.metric_key(), "skipped:no_gateway");
}

#[tokio::test]
async fn no_egress_path_reports_not_attempted() {
    let outcome = acquire(PORT, None, Some(IpAddr::V4(REFLEXIVE))).await;
    assert!(matches!(
        outcome,
        Outcome::NotAttempted(SkipReason::NoEgressPath)
    ));
    assert_eq!(outcome.metric_key(), "skipped:no_egress_path");
}

/// A pinhole with no v6 path or no v6 first hop is "not attempted", and each
/// says which, for the same reason the v4 skips do.
#[tokio::test]
async fn pinhole_skips_are_reported_by_reason() {
    let outcome = acquire_pinhole(PORT, None).await;
    assert_eq!(outcome.metric_key(), "skipped:no_v6_path");
    let egress = EgressPath6 {
        local: std::net::Ipv6Addr::LOCALHOST,
        interface_index: 0,
        interface_name: "test".to_string(),
        gateway: None,
    };
    let outcome = acquire_pinhole(PORT, Some(&egress)).await;
    assert_eq!(outcome.metric_key(), "skipped:no_v6_gateway");
}

/// A v6 gateway that never answers PCP, with no IGD to fall back to, is
/// unsupported in bounded time.
#[tokio::test]
async fn a_silent_v6_gateway_is_unsupported_and_bounded() {
    let egress = EgressPath6 {
        local: std::net::Ipv6Addr::LOCALHOST,
        interface_index: 0,
        interface_name: "test".to_string(),
        // Documentation prefix: routed nowhere from loopback, so silence.
        gateway: Some("2001:db8::1".parse().unwrap()),
    };
    let started = Instant::now();
    let outcome = acquire_pinhole_with(PORT, Some(&egress), fast(), ports(PXP_PORT, 1)).await;
    assert!(
        matches!(outcome, PinholeOutcome::Unsupported),
        "silence with no IGD is unsupported: {}",
        outcome.metric_key()
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn upnp_renewal_keeps_the_internal_port_when_the_external_port_differs() {
    let (address, seen) = upnp::tests::fake_igd(String::new(), |_, _| (200, String::new())).await;
    let mut lease = Lease {
        external: "203.0.113.1:51234".parse().unwrap(),
        protocol: Protocol::Upnp,
        lifetime: Duration::from_secs(120),
        expires_at: Instant::now() + Duration::from_secs(120),
        epoch: 0,
        gateway: "192.168.1.1".parse().unwrap(),
        interface_index: 7,
        local_ipv4: "192.168.1.10".parse().unwrap(),
        inner: LeaseHandle::Upnp {
            control: upnp::ControlUrl {
                address,
                host: address.to_string(),
                path: "/ctl".into(),
                service_type: "urn:schemas-upnp-org:service:WANIPConnection:2",
                source: None,
            },
            external_port: 51_234,
            internal_port: PORT,
            client: "192.168.1.10".parse().unwrap(),
            lease_secs: 120,
        },
    };
    assert!(renew(&mut lease).await);
    let (_, request) = seen.lock().unwrap()[0].clone();
    assert!(request.contains("<NewInternalPort>44433</NewInternalPort>"));
    assert!(request.contains("<NewExternalPort>51234</NewExternalPort>"));
    assert!(request.contains("<NewInternalClient>192.168.1.10</NewInternalClient>"));
    assert!(request.contains("<NewLeaseDuration>120</NewLeaseDuration>"));
    assert_eq!(lease.external.port(), 51_234);
    lease.expires_at = Instant::now() + Duration::from_secs(10);
    assert_eq!(
        lease.renew_after(),
        Duration::ZERO,
        "slow maintenance cannot extend the renewal deadline"
    );
}

/// The datagram parsers read bytes any LAN host can send to the probe socket.
#[test]
fn datagram_input_never_panics_the_parsers() {
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let nonce = [7u8; 12];
    let mut buf = [0u8; 128];
    for _ in 0..50_000 {
        let len = (next() % 128) as usize;
        for byte in &mut buf[..len] {
            *byte = next() as u8;
        }
        // Bias the first bytes toward the versions and opcodes that parse.
        if len >= 2 {
            buf[0] = [0, 2][(next() % 2) as usize];
            buf[1] = [0x80, 0x81][(next() % 2) as usize];
        }
        let bytes = &buf[..len];
        let _ = pcp::parse_announce(bytes);
        let _ = pcp::parse_map_response(bytes, &nonce, PORT);
        let _ = natpmp::parse_answer(bytes);
        let _ = natpmp::parse_map_response(bytes, PORT);
        let _ = announce::decode(bytes);
    }
}

/// Every outcome key must be inside the closed set the TypeScript reader
/// validates against, or the event is rejected and the metric silently stops.
///
/// `METRIC_KEYS` is the Rust half of that contract; the TypeScript half is
/// `NAT_MAPPING_OUTCOMES` in `apps/daemon/src/services/dataplane-client.ts`,
/// and `packages/shared/src/ipc-wire-conformance.test.ts` asserts the two
/// lists are identical. This test pins that every emitter draws from the list.
#[test]
fn every_outcome_key_is_in_the_closed_set_the_reader_accepts() {
    for key in [
        Outcome::Unsupported.metric_key(),
        Outcome::InnerNat.metric_key(),
        Outcome::NotAttempted(SkipReason::NoGateway).metric_key(),
        Outcome::NotAttempted(SkipReason::NoEgressPath).metric_key(),
        Outcome::NotAttempted(SkipReason::ReflexiveUnknown).metric_key(),
        PinholeOutcome::Unsupported.metric_key(),
        PinholeOutcome::NotAttempted(PinholeSkip::NoV6Path).metric_key(),
        PinholeOutcome::NotAttempted(PinholeSkip::NoV6Gateway).metric_key(),
    ] {
        assert!(METRIC_KEYS.contains(&key), "unaccepted key: {key}");
    }
    for protocol in [Protocol::Pcp, Protocol::NatPmp, Protocol::Upnp] {
        assert!(METRIC_KEYS.contains(&protocol.mapped_key()));
        assert!(METRIC_KEYS.contains(&protocol.renewed_key()));
    }
    for protocol in [PinholeProtocol::Pcp6, PinholeProtocol::Upnp6] {
        assert!(METRIC_KEYS.contains(&protocol.pinholed_key()));
        assert!(METRIC_KEYS.contains(&protocol.renewed_key()));
    }
    let mut sorted = METRIC_KEYS.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), METRIC_KEYS.len(), "duplicate metric key");
}
