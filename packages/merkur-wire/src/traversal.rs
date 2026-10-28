//! Native socket candidates. Browser signaling is unchanged.

use crate::signaling::{CandidateKind, DirectCandidate};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};

/// The existing manifest bound also bounds native socket/candidate ownership.
pub const MAX_BINDINGS: usize = 10;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub ticket: String,
    pub transaction: String,
    pub mapped: SocketAddr,
    pub observer: SocketAddr,
    pub receipt: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub address: SocketAddr,
    pub kind: CandidateKind,
    pub observation: Observation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub id: u64,
    pub family: u8,
    pub candidates: Vec<Candidate>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub generation: u64,
    pub bindings: Vec<Binding>,
    pub mac: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Offer {
    pub client_generation: u64,
    pub generation: u64,
    pub cert_hash: String,
    pub candidates: Vec<DirectCandidate>,
    pub mac: String,
}

fn bytes(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(&(value.len() as u64).to_be_bytes());
    out.extend_from_slice(value);
}

fn address(out: &mut Vec<u8>, value: SocketAddr) {
    match value.ip().to_canonical() {
        IpAddr::V4(ip) => {
            out.push(4);
            out.extend_from_slice(&ip.octets());
        }
        IpAddr::V6(ip) => {
            out.push(6);
            out.extend_from_slice(&ip.octets());
        }
    }
    out.extend_from_slice(&value.port().to_be_bytes());
}

fn kind(value: CandidateKind) -> u8 {
    match value {
        CandidateKind::Srflx => 0,
        CandidateKind::NatMap => 1,
        CandidateKind::Host4 => 2,
        CandidateKind::Host6 => 3,
        CandidateKind::Loopback => 4,
        CandidateKind::Tftp => 5,
        CandidateKind::Sip => 6,
    }
}

fn valid_address(value: SocketAddr) -> bool {
    value == SocketAddr::new(value.ip().to_canonical(), value.port())
        && value.port() != 0
        && !value.ip().is_unspecified()
        && !value.ip().is_multicast()
}

fn valid_observer_identity(value: SocketAddr) -> bool {
    value == SocketAddr::new(value.ip().to_canonical(), value.port())
        && value.port() != 0
        && !value.ip().is_multicast()
}

impl Snapshot {
    pub fn is_valid(&self) -> bool {
        self.generation > 0
            && self.generation <= 9_007_199_254_740_991
            && !self.bindings.is_empty()
            && self.bindings.len() <= MAX_BINDINGS
            && self.mac.len() == 86
            && self
                .bindings
                .iter()
                .map(|binding| binding.candidates.len())
                .sum::<usize>()
                <= MAX_BINDINGS
            && self.bindings.iter().enumerate().all(|(index, binding)| {
                binding.id > 0
                    && binding.id <= 9_007_199_254_740_991
                    && !self
                        .bindings
                        .iter()
                        .take(index)
                        .any(|other| other.id == binding.id)
                    && matches!(binding.family, 4 | 6)
                    && binding.candidates.iter().all(|candidate| {
                        valid_address(candidate.address)
                            && valid_address(candidate.observation.mapped)
                            && valid_observer_identity(candidate.observation.observer)
                            && candidate.address.is_ipv4() == (binding.family == 4)
                            && matches!(
                                candidate.kind,
                                CandidateKind::Srflx | CandidateKind::Host6 | CandidateKind::NatMap
                            )
                            && candidate.observation.ticket.len() == 55
                            && candidate.observation.transaction.len() == 16
                            && candidate.observation.receipt.len() == 43
                            && candidate.address.ip() == candidate.observation.mapped.ip()
                            && (candidate.kind == CandidateKind::NatMap
                                || candidate.address == candidate.observation.mapped)
                    })
            })
    }

    pub fn transcript(&self) -> Vec<u8> {
        let mut out = b"merkur-traversal/snapshot\0".to_vec();
        out.extend_from_slice(&self.generation.to_be_bytes());
        out.extend_from_slice(&(self.bindings.len() as u64).to_be_bytes());
        for binding in &self.bindings {
            out.extend_from_slice(&binding.id.to_be_bytes());
            out.push(binding.family);
            out.extend_from_slice(&(binding.candidates.len() as u64).to_be_bytes());
            for candidate in &binding.candidates {
                address(&mut out, candidate.address);
                out.push(kind(candidate.kind));
                bytes(&mut out, candidate.observation.ticket.as_bytes());
                bytes(&mut out, candidate.observation.transaction.as_bytes());
                address(&mut out, candidate.observation.mapped);
                address(&mut out, candidate.observation.observer);
                bytes(&mut out, candidate.observation.receipt.as_bytes());
            }
        }
        out
    }
}

impl Offer {
    pub fn is_valid(&self) -> bool {
        self.client_generation > 0
            && self.generation > 0
            && self.client_generation <= 9_007_199_254_740_991
            && self.generation <= 9_007_199_254_740_991
            && self.cert_hash.len() == 44
            && self.mac.len() == 86
            && self.candidates.len() <= MAX_BINDINGS
            && self.candidates.iter().all(|candidate| {
                candidate.admission == 0
                    && valid_address(SocketAddr::new(candidate.addr, candidate.port))
            })
    }

    pub fn transcript(&self) -> Vec<u8> {
        let mut out = b"merkur-traversal/offer\0".to_vec();
        out.extend_from_slice(&self.client_generation.to_be_bytes());
        out.extend_from_slice(&self.generation.to_be_bytes());
        bytes(&mut out, self.cert_hash.as_bytes());
        out.extend_from_slice(&(self.candidates.len() as u64).to_be_bytes());
        for candidate in &self.candidates {
            address(&mut out, SocketAddr::new(candidate.addr, candidate.port));
            out.push(kind(candidate.kind));
            out.push(match candidate.scope {
                crate::signaling::CandidateScope::Public => 0,
                crate::signaling::CandidateScope::Local => 1,
            });
        }
        out
    }
}
