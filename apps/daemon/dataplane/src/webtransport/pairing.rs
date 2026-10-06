use std::net::IpAddr;

use serde::Serialize;

use super::stun::NatMapping;
use super::{AddressCandidate, AddressClass, CandidateFlavor, classify_ip};

/// Compact NAT/srflx context that the manifest carries to the browser.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NatSignature {
    pub public_ip: Option<String>,
    pub nat_type: NatTypeLabel,
    pub hairpin: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NatTypeLabel {
    EndpointIndependent,
    EndpointDependent,
    None,
}

impl From<NatMapping> for NatTypeLabel {
    fn from(value: NatMapping) -> Self {
        match value {
            NatMapping::EndpointIndependent => Self::EndpointIndependent,
            NatMapping::EndpointDependent => Self::EndpointDependent,
            NatMapping::Unknown => Self::None,
        }
    }
}

/// Whether dialing an address leaves the local network, as a browser's local
/// network access policy classifies it. The browser dials `Public` candidates
/// first and consults its local-network permission before a `Local` one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateScope {
    /// A globally routable address.
    Public,
    /// Private, shared-address (CGNAT), unique-local, link-local or loopback.
    Local,
}

pub fn candidate_scope(addr: &str) -> CandidateScope {
    match addr.parse::<IpAddr>().map(|ip| classify_ip(&ip)) {
        Ok(AddressClass::Ipv4Global | AddressClass::Ipv6Global) => CandidateScope::Public,
        _ => CandidateScope::Local,
    }
}

/// Every candidate the browser at `browser_address` may dial.
///
/// Reachability is not inferred from addresses: whether a LAN, overlay or
/// reflexive candidate answers is something only a dial establishes, and the
/// browser orders its dials. So every browser gets the daemon's whole candidate
/// set, with one exception that is a fact rather than a guess: a browser the
/// edge observed on loopback runs on this host (the dev and e2e topology, where
/// browser, edge and daemon share one machine). It gets this host's loopback
/// addresses alone, so no interface address can route around whatever the
/// topology put between the two.
pub fn manifest_candidates(
    candidates: &[AddressCandidate],
    browser_address: IpAddr,
    port: u16,
) -> Vec<AddressCandidate> {
    if browser_address.is_loopback() {
        return vec![
            AddressCandidate {
                addr: "127.0.0.1".into(),
                port,
                kind: CandidateFlavor::Loopback,
            },
            AddressCandidate {
                addr: "::1".into(),
                port,
                kind: CandidateFlavor::Loopback,
            },
        ];
    }
    candidates
        .iter()
        .filter(|candidate| !matches!(candidate.kind, CandidateFlavor::Loopback))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use super::*;

    fn candidate(addr: &str, port: u16, kind: CandidateFlavor) -> AddressCandidate {
        AddressCandidate {
            addr: addr.into(),
            port,
            kind,
        }
    }

    fn full_candidate_set(port: u16) -> Vec<AddressCandidate> {
        vec![
            candidate("203.0.113.5", port, CandidateFlavor::Srflx),
            candidate("203.0.113.5", 51_000, CandidateFlavor::NatMap),
            candidate("192.168.1.10", port, CandidateFlavor::Host4),
            candidate("2001:db8::10", port, CandidateFlavor::Host6),
            candidate("100.64.0.5", port, CandidateFlavor::Host4),
            candidate("fd7a:115c:a1e0::5", port, CandidateFlavor::Host6),
        ]
    }

    /// Two browsers on unrelated networks get the same manifest: nothing about
    /// where a browser is decides what the daemon may be dialed at.
    #[test]
    fn every_non_loopback_browser_gets_the_whole_candidate_set() {
        let candidates = full_candidate_set(5000);
        let home = manifest_candidates(&candidates, "203.0.113.5".parse().unwrap(), 5000);
        let cellular = manifest_candidates(&candidates, "198.51.100.7".parse().unwrap(), 5000);
        let ipv6 = manifest_candidates(&candidates, "2001:db8:9::7".parse().unwrap(), 5000);
        assert_eq!(home, candidates);
        assert_eq!(cellular, candidates);
        assert_eq!(ipv6, candidates);
    }

    /// A loopback observation means browser, edge and daemon share this host;
    /// only this host's loopback addresses are offered, so no interface address
    /// can bypass what the topology put between them.
    #[test]
    fn a_loopback_browser_gets_loopback_candidates_only() {
        let candidates = full_candidate_set(5000);
        for browser in ["127.0.0.1", "::1"] {
            let manifest = manifest_candidates(&candidates, browser.parse().unwrap(), 5000);
            assert_eq!(
                manifest,
                [
                    candidate("127.0.0.1", 5000, CandidateFlavor::Loopback),
                    candidate("::1", 5000, CandidateFlavor::Loopback),
                ],
                "{browser}"
            );
        }
    }

    #[test]
    fn a_global_address_is_public_and_every_other_class_is_local() {
        for public in ["203.0.113.5", "2001:db8::10"] {
            assert_eq!(candidate_scope(public), CandidateScope::Public, "{public}");
        }
        for local in [
            "192.168.1.10",
            "10.0.0.5",
            "100.64.0.5",
            "fd7a:115c:a1e0::5",
            "169.254.10.20",
            "fe80::1",
            "127.0.0.1",
            "::1",
        ] {
            assert_eq!(candidate_scope(local), CandidateScope::Local, "{local}");
        }
    }

    #[test]
    fn classify_ipv4_recognizes_link_local_as_non_routable() {
        let ll = "169.254.10.20".parse::<Ipv4Addr>().unwrap();
        assert_eq!(super::super::classify_ipv4(&ll), AddressClass::NonRoutable);
    }

    #[test]
    fn classify_ipv4_recognizes_cgnat() {
        let cg = "100.64.0.5".parse::<Ipv4Addr>().unwrap();
        assert_eq!(super::super::classify_ipv4(&cg), AddressClass::Ipv4Cgnat);
    }

    #[test]
    fn classify_ipv6_recognizes_ula() {
        let ula = "fd7a:115c:a1e0::5".parse::<Ipv6Addr>().unwrap();
        assert_eq!(
            super::super::classify_ipv6(&ula),
            AddressClass::Ipv6UniqueLocal
        );
    }

    #[test]
    fn classify_ipv6_recognizes_link_local_as_non_routable() {
        let ll = "fe80::1".parse::<Ipv6Addr>().unwrap();
        assert_eq!(super::super::classify_ipv6(&ll), AddressClass::NonRoutable);
    }
}
