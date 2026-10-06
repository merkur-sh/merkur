//! PCP (RFC 6887) MAP for both address families, bound to the source it names.
//!
//! # Why the source is bound
//!
//! A PCP request's "client IP address" field must equal the packet's source
//! address or the server answers `ADDRESS_MISMATCH` (§8.1). Letting the kernel
//! choose the source breaks that twice: on IPv6 the first hop is addressed by
//! its link-local address, so RFC 6724 selection picks the daemon's link-local
//! address instead of the global one a pinhole is for; on a multihomed IPv4 host
//! the kernel may pick an interface other than the resolved egress path. So the
//! socket binds the egress address and the request names the same one.
//!
//! One socket per exchange rather than one held open: an exchange happens at
//! most once per half-lifetime, and a long-lived socket would only be one more
//! file description to keep straight across a path edge.
//!
//! IPv4 addresses travel as IPv4-mapped IPv6 addresses (§5).

use std::net::{IpAddr, Ipv6Addr, SocketAddr, SocketAddrV6};

use tokio::net::UdpSocket;
use tracing::debug;

use super::RetransmitSchedule;

pub const VERSION: u8 = 2;
pub const OPCODE_ANNOUNCE: u8 = 0;
const OPCODE_MAP: u8 = 1;
pub const RESPONSE_BIT: u8 = 0x80;
const PROTOCOL_UDP: u8 = 17;
/// §7.1 common header.
pub const HEADER_LEN: usize = 24;
const REQUEST_LEN: usize = 60;
/// Responses are the request length plus any options; §7.2 caps a message at
/// 1100 bytes.
pub const MAX_RESPONSE_LEN: usize = 1100;
/// §7.4 result 1. Also what a NAT-PMP-only server puts in its version-0 reply.
pub const RESULT_UNSUPP_VERSION: u8 = 1;

/// A non-success §7.4 result code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultCode {
    /// §7.4 result 1. The server speaks NAT-PMP only.
    UnsupportedVersion,
    /// Any other §7.4 code, carried for the log.
    Refused(u8),
}

/// A granted MAP: what the server said, and what renewing it needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mapping {
    pub lifetime_secs: u32,
    pub epoch: u32,
    pub nonce: [u8; 12],
    pub assigned_external_port: u16,
    /// The address the server says the mapping is reachable at. For a CPE
    /// proxying PCP to a carrier-grade NAT this is the CGN's address, which is
    /// what the caller compares against the STUN-observed public address.
    pub assigned_external: IpAddr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Result(ResultCode),
    /// Every retransmission drew silence.
    Silent,
    Socket,
}

/// Where the exchange goes. `port` is 5351 in production (§19.1); tests point
/// it at a fake server.
#[derive(Debug, Clone, Copy)]
pub struct Server {
    pub gateway: IpAddr,
    /// IPv6 scope for a link-local gateway; ignored for IPv4.
    pub interface: u32,
    pub port: u16,
}

/// The 16-byte wire form of an address: IPv6 as is, IPv4 mapped.
pub fn wire_address(address: IpAddr) -> [u8; 16] {
    match address {
        IpAddr::V4(v4) => v4.to_ipv6_mapped().octets(),
        IpAddr::V6(v6) => v6.octets(),
    }
}

fn from_wire(bytes: &[u8]) -> IpAddr {
    let mut octets = [0u8; 16];
    octets.copy_from_slice(&bytes[..16]);
    let v6 = Ipv6Addr::from(octets);
    match v6.to_ipv4_mapped() {
        Some(v4) => IpAddr::V4(v4),
        None => IpAddr::V6(v6),
    }
}

/// A socket bound to `client` and connected to the server.
pub async fn bind(client: IpAddr, server: Server) -> Result<UdpSocket, Failure> {
    let (local, remote) = match (client, server.gateway) {
        (IpAddr::V4(client), IpAddr::V4(gateway)) => (
            SocketAddr::new(IpAddr::V4(client), 0),
            SocketAddr::new(IpAddr::V4(gateway), server.port),
        ),
        (IpAddr::V6(client), IpAddr::V6(gateway)) => {
            let scope = if is_link_local(&gateway) { server.interface } else { 0 };
            (
                SocketAddr::V6(SocketAddrV6::new(client, 0, 0, 0)),
                SocketAddr::V6(SocketAddrV6::new(gateway, server.port, 0, scope)),
            )
        }
        _ => return Err(Failure::Socket),
    };
    let socket = UdpSocket::bind(local).await.map_err(|_| Failure::Socket)?;
    socket.connect(remote).await.map_err(|_| Failure::Socket)?;
    Ok(socket)
}

/// The §14.1 ANNOUNCE request: a header with lifetime zero. It changes nothing
/// on the server, which is what makes it safe to send beside a NAT-PMP probe.
pub fn announce_request(client: IpAddr) -> [u8; HEADER_LEN] {
    let mut request = [0u8; HEADER_LEN];
    request[0] = VERSION;
    request[1] = OPCODE_ANNOUNCE;
    request[8..24].copy_from_slice(&wire_address(client));
    request
}

/// What an ANNOUNCE answer says, or `None` for anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnnounceAnswer {
    Present { epoch: u32 },
    Refused(u8),
}

pub fn parse_announce(bytes: &[u8]) -> Option<AnnounceAnswer> {
    if bytes.len() < HEADER_LEN
        || bytes[0] != VERSION
        || bytes[1] != (OPCODE_ANNOUNCE | RESPONSE_BIT)
    {
        return None;
    }
    Some(match bytes[3] {
        0 => AnnounceAnswer::Present {
            epoch: u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
        },
        other => AnnounceAnswer::Refused(other),
    })
}

fn map_request(
    client: IpAddr,
    port: u16,
    lifetime_secs: u32,
    nonce: &[u8; 12],
    suggested_external: IpAddr,
) -> [u8; REQUEST_LEN] {
    let mut request = [0u8; REQUEST_LEN];
    request[0] = VERSION;
    request[1] = OPCODE_MAP;
    request[4..8].copy_from_slice(&lifetime_secs.to_be_bytes());
    request[8..24].copy_from_slice(&wire_address(client));
    request[24..36].copy_from_slice(nonce);
    request[36] = PROTOCOL_UDP;
    request[40..42].copy_from_slice(&port.to_be_bytes());
    request[42..44].copy_from_slice(&port.to_be_bytes());
    request[44..60].copy_from_slice(&wire_address(suggested_external));
    request
}

/// Send one MAP request from `client` for UDP `port`, with `lifetime_secs`
/// (0 deletes). `nonce` must be the same across acquire, renew and delete of one
/// mapping. `suggested_external` is the address the mapping is wanted on: the
/// STUN-observed public address for IPv4, the client itself for a pinhole.
pub async fn map(
    client: IpAddr,
    server: Server,
    port: u16,
    lifetime_secs: u32,
    nonce: [u8; 12],
    suggested_external: IpAddr,
    schedule: RetransmitSchedule,
) -> Result<Mapping, Failure> {
    let socket = bind(client, server).await?;
    let request = map_request(client, port, lifetime_secs, &nonce, suggested_external);
    let mut response = [0u8; MAX_RESPONSE_LEN];
    let mut interval = schedule.initial;
    for _ in 0..schedule.attempts.max(1) {
        socket.send(&request).await.map_err(|_| Failure::Socket)?;
        let deadline = tokio::time::Instant::now() + interval;
        loop {
            let Ok(received) = tokio::time::timeout_at(deadline, socket.recv(&mut response)).await
            else {
                break;
            };
            let len = received.map_err(|_| Failure::Socket)?;
            match parse_map_response(&response[..len], &nonce, port) {
                Some(Ok(mapping)) => return Ok(mapping),
                Some(Err(code)) => return Err(Failure::Result(code)),
                // Not ours, or malformed: keep waiting out this interval.
                None => {}
            }
        }
        interval = (interval * 2).min(schedule.max_interval);
    }
    debug!(gateway = %server.gateway, port, "pcp: no answer across the retransmission schedule");
    Err(Failure::Silent)
}

/// Decode a MAP response addressed to this request.
///
/// `None` is "not this transaction": a stray datagram, a response to another
/// nonce, or bytes that do not parse. `Some(Err)` is the server refusing.
pub fn parse_map_response(
    bytes: &[u8],
    nonce: &[u8; 12],
    port: u16,
) -> Option<Result<Mapping, ResultCode>> {
    if bytes.len() < HEADER_LEN || bytes[0] != VERSION || bytes[1] != (OPCODE_MAP | RESPONSE_BIT) {
        // §9: a NAT-PMP-only server answers with version 0 and result 1.
        if bytes.len() >= 4
            && bytes[0] == 0
            && u16::from_be_bytes([bytes[2], bytes[3]]) == u16::from(RESULT_UNSUPP_VERSION)
        {
            return Some(Err(ResultCode::UnsupportedVersion));
        }
        return None;
    }
    let result = bytes[3];
    let lifetime_secs = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let epoch = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    if result != 0 {
        return Some(Err(match result {
            RESULT_UNSUPP_VERSION => ResultCode::UnsupportedVersion,
            other => ResultCode::Refused(other),
        }));
    }
    if bytes.len() < REQUEST_LEN || &bytes[24..36] != nonce {
        return None;
    }
    if bytes[36] != PROTOCOL_UDP || u16::from_be_bytes([bytes[40], bytes[41]]) != port {
        return None;
    }
    Some(Ok(Mapping {
        lifetime_secs,
        epoch,
        nonce: *nonce,
        assigned_external_port: u16::from_be_bytes([bytes[42], bytes[43]]),
        assigned_external: from_wire(&bytes[44..60]),
    }))
}

fn is_link_local(addr: &Ipv6Addr) -> bool {
    let octets = addr.octets();
    octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80
}

/// The IPv4 form of `address` when it is IPv4-mapped, for comparisons.
pub fn unmapped(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(address, IpAddr::V4),
        v4 => v4,
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use std::time::Duration;

    pub(in super::super) fn map_response(
        nonce: &[u8; 12],
        port: u16,
        result: u8,
        lifetime: u32,
        external: IpAddr,
    ) -> [u8; REQUEST_LEN] {
        let mut bytes = [0u8; REQUEST_LEN];
        bytes[0] = VERSION;
        bytes[1] = OPCODE_MAP | RESPONSE_BIT;
        bytes[3] = result;
        bytes[4..8].copy_from_slice(&lifetime.to_be_bytes());
        bytes[8..12].copy_from_slice(&7u32.to_be_bytes());
        bytes[24..36].copy_from_slice(nonce);
        bytes[36] = PROTOCOL_UDP;
        bytes[40..42].copy_from_slice(&port.to_be_bytes());
        bytes[42..44].copy_from_slice(&port.to_be_bytes());
        bytes[44..60].copy_from_slice(&wire_address(external));
        bytes
    }

    pub(in super::super) fn announce_response(result: u8, epoch: u32) -> [u8; HEADER_LEN] {
        let mut bytes = [0u8; HEADER_LEN];
        bytes[0] = VERSION;
        bytes[1] = OPCODE_ANNOUNCE | RESPONSE_BIT;
        bytes[3] = result;
        bytes[8..12].copy_from_slice(&epoch.to_be_bytes());
        bytes
    }

    fn external() -> IpAddr {
        "203.0.113.9".parse().unwrap()
    }

    #[test]
    fn a_success_response_is_bound_to_nonce_and_port_and_carries_the_external_address() {
        let nonce = [9u8; 12];
        let ok = map_response(&nonce, 44_433, 0, 1800, external());
        assert_eq!(
            parse_map_response(&ok, &nonce, 44_433),
            Some(Ok(Mapping {
                lifetime_secs: 1800,
                epoch: 7,
                nonce,
                assigned_external_port: 44_433,
                assigned_external: external(),
            }))
        );
        assert_eq!(parse_map_response(&ok, &[1u8; 12], 44_433), None, "another nonce");
        assert_eq!(parse_map_response(&ok, &nonce, 44_434), None, "another port");
    }

    #[test]
    fn an_ipv6_external_address_is_not_mistaken_for_ipv4() {
        let nonce = [9u8; 12];
        let v6: IpAddr = "2001:db8::5".parse().unwrap();
        let ok = map_response(&nonce, 44_433, 0, 60, v6);
        let mapping = parse_map_response(&ok, &nonce, 44_433).unwrap().unwrap();
        assert_eq!(mapping.assigned_external, v6);
    }

    /// Request encoding and response decoding are fixed-buffer work.
    #[test]
    fn encoding_and_decoding_a_map_exchange_allocates_nothing() {
        let nonce = [9u8; 12];
        let ok = map_response(&nonce, 44_433, 0, 1800, external());
        crate::edge_tunnel::test_allocations::begin_thread();
        let request = map_request(external(), 44_433, 1800, &nonce, external());
        let parsed = parse_map_response(&ok, &nonce, 44_433);
        let announce = parse_announce(&announce_response(0, 3));
        let tally = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(request.len(), REQUEST_LEN);
        assert!(matches!(parsed, Some(Ok(_))));
        assert_eq!(announce, Some(AnnounceAnswer::Present { epoch: 3 }));
        assert_eq!(tally.allocations, 0);
    }

    #[test]
    fn refusals_and_natpmp_only_servers_are_distinguished_from_silence() {
        let nonce = [9u8; 12];
        let refused = map_response(&nonce, 44_433, 2, 0, external());
        assert_eq!(
            parse_map_response(&refused, &nonce, 44_433),
            Some(Err(ResultCode::Refused(2)))
        );
        // NAT-PMP's UNSUPP_VERSION: version 0, result code 1 in bytes 2..4.
        let natpmp = [0u8, 0x80, 0, 1, 0, 0, 0, 0];
        assert_eq!(
            parse_map_response(&natpmp, &nonce, 44_433),
            Some(Err(ResultCode::UnsupportedVersion))
        );
        assert_eq!(parse_map_response(&[2u8, 0x81, 0], &nonce, 44_433), None);
    }

    #[test]
    fn announce_answers_decode_and_nothing_else_does() {
        assert_eq!(
            parse_announce(&announce_response(0, 11)),
            Some(AnnounceAnswer::Present { epoch: 11 })
        );
        assert_eq!(
            parse_announce(&announce_response(2, 11)),
            Some(AnnounceAnswer::Refused(2))
        );
        let nonce = [1u8; 12];
        assert_eq!(parse_announce(&map_response(&nonce, 1, 0, 1, external())), None);
        assert_eq!(parse_announce(&[2u8, 0x80]), None);
        let request = announce_request("192.168.1.10".parse().unwrap());
        assert_eq!(request[0], VERSION);
        assert_eq!(request[1], OPCODE_ANNOUNCE);
        assert_eq!(
            from_wire(&request[8..24]),
            "192.168.1.10".parse::<IpAddr>().unwrap(),
            "an IPv4 client travels IPv4-mapped"
        );
    }

    /// The wire path against a fake server on loopback, which also proves the
    /// request leaves from the address it names.
    #[tokio::test]
    async fn the_request_carries_the_bound_source_address_and_is_answered() {
        for (client, server_bind) in [
            (IpAddr::V6(Ipv6Addr::LOCALHOST), "[::1]:0"),
            (IpAddr::V4(Ipv4Addr::LOCALHOST), "127.0.0.1:0"),
        ] {
            let server = UdpSocket::bind(server_bind).await.unwrap();
            let server_port = server.local_addr().unwrap().port();
            tokio::spawn(async move {
                let mut buf = [0u8; 128];
                let (len, from) = server.recv_from(&mut buf).await.unwrap();
                assert_eq!(len, REQUEST_LEN);
                assert_eq!(from_wire(&buf[8..24]), from.ip());
                let nonce: [u8; 12] = buf[24..36].try_into().unwrap();
                let port = u16::from_be_bytes([buf[40], buf[41]]);
                let external = from_wire(&buf[44..60]);
                let _ = server
                    .send_to(&map_response(&nonce, port, 0, 600, external), from)
                    .await;
            });
            let mapping = map(
                client,
                Server {
                    gateway: client,
                    interface: 0,
                    port: server_port,
                },
                44_433,
                600,
                [3u8; 12],
                client,
                RetransmitSchedule {
                    initial: Duration::from_millis(500),
                    max_interval: Duration::from_millis(500),
                    attempts: 2,
                },
            )
            .await
            .expect("answered");
            assert_eq!(mapping.lifetime_secs, 600);
            assert_eq!(mapping.assigned_external_port, 44_433);
            assert_eq!(mapping.assigned_external, client);
        }
    }
}
