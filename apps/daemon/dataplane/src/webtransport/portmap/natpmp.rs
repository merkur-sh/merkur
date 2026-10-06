//! NAT-PMP (RFC 6886): the external-address request and the UDP map.
//!
//! Hand-rolled for the same reason as [`super::pcp`]: the request has to leave
//! from the resolved egress address, and the external-address answer is the one
//! fact that says whether this gateway is the NAT a browser would reach.

use std::net::{IpAddr, Ipv4Addr};

use tracing::debug;

use super::RetransmitSchedule;
use super::pcp::{self, Failure, Server};

pub const VERSION: u8 = 0;
pub const OP_EXTERNAL_ADDRESS: u8 = 0;
const OP_MAP_UDP: u8 = 1;
pub const RESPONSE_BIT: u8 = 0x80;
/// §3.5 result 1.
pub const RESULT_UNSUPP_VERSION: u16 = 1;

/// The two-byte external-address request (§3.2).
pub const EXTERNAL_ADDRESS_REQUEST: [u8; 2] = [VERSION, OP_EXTERNAL_ADDRESS];

/// What a version-0 datagram on 5351 says, or `None` for anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// The external-address answer: NAT-PMP is here.
    External { epoch: u32, address: Ipv4Addr },
    /// A version-0 `UNSUPP_VERSION`: the server speaks only NAT-PMP and
    /// refused a PCP request.
    PcpUnsupported,
    /// Any other result code on the external-address answer.
    Refused(u16),
}

pub fn parse_answer(bytes: &[u8]) -> Option<Answer> {
    if bytes.len() < 4 || bytes[0] != VERSION || bytes[1] != (OP_EXTERNAL_ADDRESS | RESPONSE_BIT)
    {
        return None;
    }
    let result = u16::from_be_bytes([bytes[2], bytes[3]]);
    if result == RESULT_UNSUPP_VERSION {
        // Our own version-0 request cannot draw this; only the PCP one can.
        return Some(Answer::PcpUnsupported);
    }
    if result != 0 {
        return Some(Answer::Refused(result));
    }
    if bytes.len() < 12 {
        return None;
    }
    Some(Answer::External {
        epoch: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        address: Ipv4Addr::new(bytes[8], bytes[9], bytes[10], bytes[11]),
    })
}

/// A granted UDP map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mapping {
    pub lifetime_secs: u32,
    pub epoch: u32,
    pub external_port: u16,
}

fn map_request(internal_port: u16, external_port: u16, lifetime_secs: u32) -> [u8; 12] {
    let mut request = [0u8; 12];
    request[0] = VERSION;
    request[1] = OP_MAP_UDP;
    request[4..6].copy_from_slice(&internal_port.to_be_bytes());
    request[6..8].copy_from_slice(&external_port.to_be_bytes());
    request[8..12].copy_from_slice(&lifetime_secs.to_be_bytes());
    request
}

pub fn parse_map_response(bytes: &[u8], internal_port: u16) -> Option<Result<Mapping, u16>> {
    if bytes.len() < 4 || bytes[0] != VERSION || bytes[1] != (OP_MAP_UDP | RESPONSE_BIT) {
        return None;
    }
    let result = u16::from_be_bytes([bytes[2], bytes[3]]);
    if result != 0 {
        return Some(Err(result));
    }
    if bytes.len() < 16 || u16::from_be_bytes([bytes[8], bytes[9]]) != internal_port {
        return None;
    }
    Some(Ok(Mapping {
        epoch: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        external_port: u16::from_be_bytes([bytes[10], bytes[11]]),
        lifetime_secs: u32::from_be_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]),
    }))
}

/// Map UDP `internal_port`, asking for the same external port, from `client`.
/// `lifetime_secs` 0 deletes (§3.4), which removes every mapping the gateway
/// holds for the internal port.
pub async fn map(
    client: Ipv4Addr,
    server: Server,
    internal_port: u16,
    lifetime_secs: u32,
    schedule: RetransmitSchedule,
) -> Result<Mapping, Failure> {
    let socket = pcp::bind(IpAddr::V4(client), server).await?;
    let request = map_request(internal_port, internal_port, lifetime_secs);
    let mut response = [0u8; 16];
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
            match parse_map_response(&response[..len], internal_port) {
                Some(Ok(mapping)) => return Ok(mapping),
                Some(Err(code)) => {
                    return Err(Failure::Result(pcp::ResultCode::Refused(
                        u8::try_from(code).unwrap_or(u8::MAX),
                    )));
                }
                None => {}
            }
        }
        interval = (interval * 2).min(schedule.max_interval);
    }
    debug!(gateway = %server.gateway, internal_port, "natpmp: no answer across the retransmission schedule");
    Err(Failure::Silent)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub(in super::super) fn external_answer(epoch: u32, address: Ipv4Addr) -> [u8; 12] {
        let mut bytes = [0u8; 12];
        bytes[1] = OP_EXTERNAL_ADDRESS | RESPONSE_BIT;
        bytes[4..8].copy_from_slice(&epoch.to_be_bytes());
        bytes[8..12].copy_from_slice(&address.octets());
        bytes
    }

    pub(in super::super) fn map_answer(request: &[u8], lifetime: u32) -> [u8; 16] {
        let mut bytes = [0u8; 16];
        bytes[1] = OP_MAP_UDP | RESPONSE_BIT;
        bytes[4..8].copy_from_slice(&5u32.to_be_bytes());
        bytes[8..10].copy_from_slice(&request[4..6]);
        bytes[10..12].copy_from_slice(&request[6..8]);
        bytes[12..16].copy_from_slice(&lifetime.to_be_bytes());
        bytes
    }

    #[test]
    fn the_external_address_answer_decodes_and_a_pcp_refusal_is_told_apart() {
        let address = Ipv4Addr::new(203, 0, 113, 7);
        assert_eq!(
            parse_answer(&external_answer(42, address)),
            Some(Answer::External { epoch: 42, address })
        );
        // A NAT-PMP-only server's reply to a PCP request.
        assert_eq!(
            parse_answer(&[0, 0x80, 0, 1, 0, 0, 0, 0]),
            Some(Answer::PcpUnsupported)
        );
        assert_eq!(parse_answer(&[0, 0x80, 0, 3]), Some(Answer::Refused(3)));
        assert_eq!(parse_answer(&[2, 0x80, 0, 0]), None, "PCP is not NAT-PMP");
        assert_eq!(parse_answer(&[0, 0x80, 0, 0]), None, "truncated");
    }

    #[test]
    fn a_map_answer_is_bound_to_the_internal_port() {
        let request = map_request(44_433, 44_433, 3600);
        let answer = map_answer(&request, 7200);
        assert_eq!(
            parse_map_response(&answer, 44_433),
            Some(Ok(Mapping {
                lifetime_secs: 7200,
                epoch: 5,
                external_port: 44_433
            }))
        );
        assert_eq!(parse_map_response(&answer, 1), None);
        assert_eq!(parse_map_response(&[0, 0x81, 0, 2], 1), Some(Err(2)));
    }
}
