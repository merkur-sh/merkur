//! Native UDP discovery and router mapping, shared by daemon and client.

pub mod check;
pub mod discovery_socket;
pub mod egress;
pub mod portmap;
pub mod sip;
pub mod stun;
mod transaction;

use serde::Serialize;

/// Wire taxonomy used for candidate ordering and diagnostics. The daemon
/// separately classifies each peer's addresses to decide reachability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateFlavor {
    /// STUN-discovered public IP. Requires hairpinning to work same-NAT.
    Srflx,
    /// An explicit port-mapping lease (PCP or NAT-PMP). The only candidate kind
    /// that does not depend on NAT filter state: the gateway has been told to
    /// forward, so unsolicited inbound is admitted by configuration rather than
    /// by a keepalive and a punch landing in time.
    NatMap,
    /// Any routable IPv4 host (RFC1918 LAN, RFC6598 CGNAT/overlay, GUA).
    Host4,
    /// Any routable IPv6 host (GUA, RFC4193 ULA / overlay).
    Host6,
    /// 127.0.0.1 / ::1, added only for the SameHost selection strategy.
    Loopback,
    /// A dedicated socket endpoint, prepared with a TFTP RRQ.
    Tftp,
    /// An unverified SDP media endpoint; never a port-mapping lease.
    Sip,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AddressCandidate {
    pub addr: String,
    pub port: u16,
    pub kind: CandidateFlavor,
}

#[cfg(test)]
mod test_allocations;
