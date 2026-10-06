//! Which interface actually carries traffic to the public internet.
//!
//! Every NAT-mapping decision derives from one answer: the PCP/NAT-PMP unicast
//! destination, the PCP client address, the SSDP multicast egress, and the
//! source address those sockets bind.
//!
//! # Why not `netdev::get_default_gateway`
//!
//! It derives "the local IP" by connecting a probe socket to `10.254.254.254` —
//! an RFC1918 address. Any VPN, container bridge, or hypervisor NAT that
//! installs a route covering `10.0.0.0/8` wins that lookup, so the "default
//! gateway" it returns is that virtual link's gateway, and mapping requests get
//! aimed at the wrong network. The failure is silent: the request is unicast to
//! a gateway that simply ignores it, so it presents as a timeout rather than an
//! error.
//!
//! The fix is to ask the question that has a right answer: *which interface
//! reaches a destination we have proof is on the public internet.* The STUN
//! probe supplies that proof, and `netdev`'s per-interface data — which is
//! correct; only its default-interface *selection* is not — supplies the
//! gateway.
//!
//! # Why a missing gateway is reported rather than returned as `None`
//!
//! `netdev` populates `Interface::gateway` only for an interface holding a
//! prefix-0 default route with an explicit next hop (Linux `netlink.rs`,
//! BSD `route/mod.rs`). The STUN-verified interface frequently is not that
//! interface: split-tunnel VPNs, policy routing, and multi-homed hosts all
//! separate "the interface that reached the internet" from "the interface
//! holding the default route".
//!
//! The previous implementation opened both datagram protocols with
//! `let gateway = egress.gateway?;`, returning *before* their first log line.
//! Two of three protocols were then silently disabled with no diagnostic in any
//! log, metric or span, and the mapping report recorded the same `false` a
//! genuinely unsupported gateway produces. That is why [`resolve_egress_path`]
//! now falls back to the OS default gateway for the *first hop only*, and why
//! [`EgressPath::gateway`] being absent is surfaced as a distinct outcome
//! rather than collapsing into "unsupported".

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use tracing::debug;

/// The path that carries traffic to the public internet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EgressPath {
    /// Source address to bind mapping sockets to, and the PCP client address.
    pub local_ipv4: Ipv4Addr,
    /// Interface index, for `IP_MULTICAST_IF` on the SSDP socket.
    pub interface_index: u32,
    pub interface_name: String,
    /// First hop, for NAT-PMP and PCP unicast.
    ///
    /// `None` only when neither the owning interface nor the OS default route
    /// names one, which on a routed host means there is genuinely nobody to
    /// ask. Callers must report that as "not attempted", never as "unsupported".
    pub gateway: Option<Ipv4Addr>,
}

/// Resolve the egress path, preferring the STUN-verified source address.
///
/// `stun_local_ip` is the address that provably reached a STUN server. When it
/// is absent — the probe failed, or the host is IPv6-only — this falls back to
/// `netdev::get_default_interface`.
///
/// Note the fallback is *not* stronger than the STUN answer, despite reading
/// that way: `get_default_interface` consults the OS default-interface flag
/// first, but netdev sets that flag from the same `connect()`-to-`10.254.254.254`
/// probe this module exists to avoid. It is a last resort, not a second opinion.
pub fn resolve_egress_path(stun_local_ip: Option<IpAddr>) -> Option<EgressPath> {
    if let Some(IpAddr::V4(local)) = stun_local_ip
        && let Some(mut path) = path_for_address(local)
    {
        // The owning interface may hold no default route while still being the
        // one that reached the internet — the split-tunnel case. Borrowing the
        // OS default first hop is strictly better than abandoning both datagram
        // protocols, and a wrong guess costs one unanswered unicast datagram.
        if path.gateway.is_none()
            && let Some(borrowed) = default_route_gateway()
        {
            debug!(
                interface = %path.interface_name,
                gateway = %borrowed,
                "egress interface holds no default route; borrowing the OS default first hop"
            );
            path.gateway = Some(borrowed);
        }
        debug!(
            interface = %path.interface_name,
            local = %path.local_ipv4,
            gateway = ?path.gateway,
            "egress path resolved from the STUN-verified source address"
        );
        return Some(path);
    }

    let interface = netdev::get_default_interface().ok()?;
    let local_ipv4 = interface.ipv4.first().map(|net| net.addr())?;
    let path = EgressPath {
        local_ipv4,
        interface_index: interface.index,
        interface_name: interface.name.clone(),
        gateway: interface
            .gateway
            .as_ref()
            .and_then(|gateway| gateway.ipv4.first().copied()),
    };
    debug!(
        interface = %path.interface_name,
        local = %path.local_ipv4,
        gateway = ?path.gateway,
        "egress path resolved from the OS default interface"
    );
    Some(path)
}

/// The IPv6 path a firewall pinhole is requested on.
///
/// There is no NAT to traverse, so the only questions are which interface
/// owns the global address a browser would dial and who its first hop is —
/// the PCP server, addressed by its link-local address with this interface as
/// the scope. The address is the pinhole's subject, so it is the source the
/// request must leave from; see `portmap::pcp6`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EgressPath6 {
    pub local: Ipv6Addr,
    pub interface_index: u32,
    pub interface_name: String,
    /// First hop, usually link-local. `None` on a routed host with no v6
    /// default route, which must be reported as "not attempted".
    pub gateway: Option<Ipv6Addr>,
}

/// Resolve the interface owning `address`, with the same borrow-the-default
/// rule as the v4 path when the owning interface holds no first hop.
pub fn resolve_egress_path_v6(address: Ipv6Addr) -> Option<EgressPath6> {
    let mut path = netdev::get_interfaces().into_iter().find_map(|interface| {
        if !interface.ipv6.iter().any(|net| net.addr() == address) {
            return None;
        }
        Some(EgressPath6 {
            local: address,
            interface_index: interface.index,
            interface_name: interface.name.clone(),
            gateway: interface
                .gateway
                .as_ref()
                .and_then(|gateway| gateway.ipv6.first().copied()),
        })
    })?;
    if path.gateway.is_none()
        && let Some(borrowed) = netdev::get_default_interface()
            .ok()
            .and_then(|interface| interface.gateway)
            .and_then(|gateway| gateway.ipv6.first().copied())
    {
        debug!(
            interface = %path.interface_name,
            gateway = %borrowed,
            "v6 egress interface holds no default route; borrowing the OS default first hop"
        );
        path.gateway = Some(borrowed);
    }
    debug!(
        interface = %path.interface_name,
        local = %path.local,
        gateway = ?path.gateway,
        "v6 egress path resolved"
    );
    Some(path)
}

/// First hop of the OS default route, whichever interface holds it.
fn default_route_gateway() -> Option<Ipv4Addr> {
    netdev::get_default_interface()
        .ok()?
        .gateway
        .as_ref()
        .and_then(|gateway| gateway.ipv4.first().copied())
}

/// Find the interface that owns `address`, and take its gateway.
fn path_for_address(address: Ipv4Addr) -> Option<EgressPath> {
    netdev::get_interfaces().into_iter().find_map(|interface| {
        if !interface.ipv4.iter().any(|net| net.addr() == address) {
            return None;
        }
        Some(EgressPath {
            local_ipv4: address,
            interface_index: interface.index,
            interface_name: interface.name.clone(),
            gateway: interface
                .gateway
                .as_ref()
                .and_then(|gateway| gateway.ipv4.first().copied()),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A v6 STUN result must not be claimed as an IPv4 egress address.
    #[test]
    fn an_ipv6_source_does_not_masquerade_as_an_ipv4_one() {
        let v6: IpAddr = "2001:db8::1".parse().unwrap();
        let from_v6 = resolve_egress_path(Some(v6));
        let from_none = resolve_egress_path(None);
        assert_eq!(
            from_v6, from_none,
            "a v6 source must fall through to the default-interface path"
        );
    }

    #[test]
    fn an_unowned_v6_address_is_not_turned_into_a_path() {
        assert!(resolve_egress_path_v6("2001:db8::dead".parse().unwrap()).is_none());
    }

    #[test]
    fn an_unowned_address_is_not_turned_into_a_path() {
        assert!(
            path_for_address("203.0.113.222".parse().unwrap()).is_none(),
            "an address no interface owns must not resolve to a path"
        );
    }

    #[test]
    fn a_resolved_path_names_an_interface_that_owns_its_address() {
        let Some(path) = resolve_egress_path(None) else {
            return; // No routable interface on this host.
        };
        let owns = netdev::get_interfaces().into_iter().any(|interface| {
            interface.name == path.interface_name
                && interface.ipv4.iter().any(|n| n.addr() == path.local_ipv4)
        });
        assert!(
            owns,
            "resolved path must name an interface owning its address"
        );
    }
}
