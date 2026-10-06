//! Gateway announcements: the one signal that a mapping was lost *before* its
//! renewal would have noticed.
//!
//! RFC 6886 §3.2.1 has a NAT-PMP gateway multicast an address-change
//! announcement to `224.0.0.1:5350` on restart, and RFC 6887 §14.1 has a PCP
//! server do the same with an ANNOUNCE response. Both carry the gateway's
//! epoch; a backwards jump means every mapping is gone. Renewal only checks
//! the epoch at half a lifetime, so without this a rebooted gateway leaves the
//! daemon advertising a dead `nat_map` candidate for up to thirty minutes.
//!
//! One socket, bound with address reuse because other clients on the host may
//! listen too, joined on the egress interface, read by a detached task into a
//! capacity-1 channel: "a gateway announced" is idempotent, so a burst
//! collapses to one wake.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

use tokio::net::UdpSocket;

const ANNOUNCE_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 1);
const ANNOUNCE_PORT: u16 = 5350;
/// A PCP ANNOUNCE response is 24 bytes, a NAT-PMP address change 12; anything
/// larger carries options this listener has no use for.
pub const MAX_ANNOUNCEMENT_LEN: usize = 64;

/// What a gateway said about itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Announcement {
    /// Seconds since the gateway's mapping table was last reset.
    pub epoch: u32,
    /// NAT-PMP announces its external address; PCP does not.
    pub external: Option<Ipv4Addr>,
}

/// Bind the announcement socket on `interface_ipv4`'s link.
pub fn bind(interface_ipv4: Ipv4Addr) -> std::io::Result<UdpSocket> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    socket.set_nonblocking(true)?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    socket.set_reuse_port(true)?;
    socket.bind(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, ANNOUNCE_PORT)).into())?;
    socket.join_multicast_v4(&ANNOUNCE_GROUP, &interface_ipv4)?;
    UdpSocket::from_std(socket.into())
}

/// Decode one datagram, or `None` for anything that is not an announcement.
pub fn decode(bytes: &[u8]) -> Option<Announcement> {
    match bytes.first()? {
        // NAT-PMP: version 0, opcode 128 (response to the public-address
        // request), result code, epoch, external address. RFC 6886 §3.2.
        0 if bytes.len() >= 12 && bytes[1] == 128 => {
            if u16::from_be_bytes([bytes[2], bytes[3]]) != 0 {
                return None;
            }
            Some(Announcement {
                epoch: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
                external: Some(Ipv4Addr::new(bytes[8], bytes[9], bytes[10], bytes[11])),
            })
        }
        // PCP: version 2, ANNOUNCE (0) with the response bit, result code at
        // byte 3, epoch at 8..12. RFC 6887 §14.1.
        2 if bytes.len() >= 24 && bytes[1] == 0x80 => {
            if bytes[3] != 0 {
                return None;
            }
            Some(Announcement {
                epoch: u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
                external: None,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_announcement_shapes_decode_and_everything_else_does_not() {
        let mut natpmp = [0u8; 12];
        natpmp[1] = 128;
        natpmp[4..8].copy_from_slice(&42u32.to_be_bytes());
        natpmp[8..12].copy_from_slice(&[203, 0, 113, 7]);
        assert_eq!(
            decode(&natpmp),
            Some(Announcement {
                epoch: 42,
                external: Some(Ipv4Addr::new(203, 0, 113, 7)),
            })
        );
        let mut pcp = [0u8; 24];
        pcp[0] = 2;
        pcp[1] = 0x80;
        pcp[8..12].copy_from_slice(&5u32.to_be_bytes());
        assert_eq!(
            decode(&pcp),
            Some(Announcement {
                epoch: 5,
                external: None,
            })
        );
        // A refused result is not an announcement of anything.
        natpmp[3] = 1;
        assert_eq!(decode(&natpmp), None);
        pcp[3] = 3;
        assert_eq!(decode(&pcp), None);
        // A MAP response on the announcement port is not an announcement.
        assert_eq!(decode(&[2u8, 0x81, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), None);
        assert_eq!(decode(&[]), None);
    }

    /// The reader task decodes into stack state only.
    #[test]
    fn decoding_allocates_nothing() {
        let mut pcp = [0u8; 24];
        pcp[0] = 2;
        pcp[1] = 0x80;
        crate::edge_tunnel::test_allocations::begin_thread();
        let decoded = decode(&pcp);
        let tally = crate::edge_tunnel::test_allocations::end_thread();
        assert!(decoded.is_some());
        assert_eq!(tally.allocations, 0);
    }
}
