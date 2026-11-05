//! Admission for connections that have not yet presented an attach ticket.
//!
//! Until a routing preface's ticket verifies, all the edge knows of a peer is
//! the address its packets come from, and the handshake, the WebTransport
//! request and the preface are work it does for anyone. This pool holds that
//! work apart from the sessions tickets admit, so a flood can only exhaust the
//! pool, and shares it by source network:
//!
//! - While it has room every attempt enters, and no dial pays a round trip.
//! - Full, an attempt from an unproven address is answered with a QUIC Retry.
//!   That is stateless: a spoofed source never holds an entry, and a real one
//!   comes back proven one round trip later.
//! - A proven attempt displaces the oldest unproven entry, which may be
//!   spoofed. With none left, it displaces the oldest entry of the network
//!   holding the most, provided its own network still holds fewer afterwards;
//!   otherwise it is ignored. No network can keep another below an equal share.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::convert::Infallible;
use std::net::IpAddr;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::oneshot;

/// Connections between their first packet and a verified ticket. A browser
/// session dials three lanes at once; this is room for hundreds of sessions
/// starting within one handshake.
pub(crate) const PENDING_CAPACITY: usize = 1024;

/// The unit sharing the pool: an IPv4 /24 or an IPv6 /48, the largest block
/// one site is commonly assigned, so one site's addresses count as one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Network {
    V4([u8; 3]),
    V6([u8; 6]),
}

impl Network {
    fn of(address: IpAddr) -> Self {
        // A dual-stack listener reports an IPv4 peer in its IPv4-mapped form.
        match address.to_canonical() {
            IpAddr::V4(address) => {
                let octets = address.octets();
                Self::V4([octets[0], octets[1], octets[2]])
            }
            IpAddr::V6(address) => {
                let mut prefix = [0; 6];
                prefix.copy_from_slice(&address.octets()[..6]);
                Self::V6(prefix)
            }
        }
    }
}

pub(crate) enum Admission {
    Admitted(Pending),
    /// Answer with a QUIC Retry: the pool is full and the address unproven.
    Retry,
    /// Ignore the attempt: the pool is full and its network holds its share.
    Refused,
}

#[derive(Clone)]
pub(crate) struct PendingPool {
    capacity: usize,
    state: Arc<Mutex<PoolState>>,
}

#[derive(Default)]
struct PoolState {
    next_id: u64,
    len: usize,
    /// Entries whose address no Retry proved, oldest first.
    unproven: BTreeMap<u64, Network>,
    /// Each network's entries, oldest first.
    networks: HashMap<Network, VecDeque<Entry>>,
}

struct Entry {
    id: u64,
    /// Dropped on displacement, which completes the holder's receiver.
    _displace: oneshot::Sender<Infallible>,
}

/// One connection's place in the pool, released on drop.
pub(crate) struct Pending {
    id: u64,
    network: Network,
    state: Arc<Mutex<PoolState>>,
    displaced: oneshot::Receiver<Infallible>,
}

impl Pending {
    /// Completes once a later attempt took this connection's place.
    pub(crate) async fn displaced(&mut self) {
        match (&mut self.displaced).await {
            Ok(never) => match never {},
            Err(_dropped) => {}
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.state.lock().remove(self.network, self.id);
    }
}

impl PendingPool {
    pub(crate) fn new() -> Self {
        Self::with_capacity(PENDING_CAPACITY)
    }

    pub(crate) fn with_capacity(capacity: usize) -> Self {
        assert!(capacity > 0, "an empty pool admits nothing");
        Self {
            capacity,
            state: Arc::new(Mutex::new(PoolState::default())),
        }
    }

    /// Admit a connection attempt from `address`; `proven` is whether a Retry
    /// already proved the attempt can receive at that address.
    pub(crate) fn admit(&self, address: IpAddr, proven: bool) -> Admission {
        let network = Network::of(address);
        let mut state = self.state.lock();
        if state.len >= self.capacity {
            if !proven {
                return Admission::Retry;
            }
            if !state.displace_oldest_unproven() && !state.displace_for(network) {
                return Admission::Refused;
            }
        }
        let id = state.next_id;
        state.next_id += 1;
        let (displace, displaced) = oneshot::channel();
        state.networks.entry(network).or_default().push_back(Entry {
            id,
            _displace: displace,
        });
        if !proven {
            state.unproven.insert(id, network);
        }
        state.len += 1;
        Admission::Admitted(Pending {
            id,
            network,
            state: Arc::clone(&self.state),
            displaced,
        })
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.state.lock().len
    }
}

impl PoolState {
    fn remove(&mut self, network: Network, id: u64) {
        let Some(entries) = self.networks.get_mut(&network) else {
            return;
        };
        let Some(index) = entries.iter().position(|entry| entry.id == id) else {
            return;
        };
        entries.remove(index);
        if entries.is_empty() {
            self.networks.remove(&network);
        }
        self.unproven.remove(&id);
        self.len -= 1;
    }

    fn displace_oldest_unproven(&mut self) -> bool {
        let Some((id, network)) = self.unproven.pop_first() else {
            return false;
        };
        self.remove(network, id);
        true
    }

    /// Make room for `network` from the network holding the most, if that
    /// leaves `network` still holding fewer.
    fn displace_for(&mut self, network: Network) -> bool {
        let own = self.networks.get(&network).map_or(0, VecDeque::len);
        let Some((heaviest, held)) = self
            .networks
            .iter()
            .map(|(network, entries)| (*network, entries.len()))
            .max_by_key(|(_, held)| *held)
        else {
            return false;
        };
        if own + 1 >= held {
            return false;
        }
        let Some(oldest) = self
            .networks
            .get(&heaviest)
            .and_then(|entries| entries.front())
        else {
            return false;
        };
        let id = oldest.id;
        self.remove(heaviest, id);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    fn admitted(admission: Admission) -> Pending {
        match admission {
            Admission::Admitted(pending) => pending,
            Admission::Retry => panic!("expected admission, got a retry"),
            Admission::Refused => panic!("expected admission, got a refusal"),
        }
    }

    fn is_displaced(pending: &mut Pending) -> bool {
        pending
            .displaced
            .try_recv()
            .is_err_and(|error| matches!(error, oneshot::error::TryRecvError::Closed))
    }

    #[test]
    fn a_pool_with_room_admits_unproven_attempts_without_a_retry() {
        let pool = PendingPool::with_capacity(2);
        let _first = admitted(pool.admit(v4(192, 0, 2, 1), false));
        let _second = admitted(pool.admit(v4(192, 0, 2, 1), false));
        assert_eq!(pool.len(), 2);
    }

    #[test]
    fn a_full_pool_answers_an_unproven_attempt_with_a_retry() {
        let pool = PendingPool::with_capacity(1);
        let _held = admitted(pool.admit(v4(192, 0, 2, 1), false));
        assert!(matches!(
            pool.admit(v4(198, 51, 100, 1), false),
            Admission::Retry
        ));
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn a_proven_attempt_displaces_the_oldest_unproven_entry() {
        let pool = PendingPool::with_capacity(2);
        let mut oldest = admitted(pool.admit(v4(203, 0, 113, 1), false));
        let mut newer = admitted(pool.admit(v4(203, 0, 113, 2), false));
        let _proven = admitted(pool.admit(v4(198, 51, 100, 1), true));
        assert!(is_displaced(&mut oldest));
        assert!(!is_displaced(&mut newer));
        assert_eq!(pool.len(), 2);
    }

    #[test]
    fn proven_entries_are_shared_by_network() {
        let pool = PendingPool::with_capacity(3);
        let mut heavy_oldest = admitted(pool.admit(v4(203, 0, 113, 1), true));
        let _heavy = admitted(pool.admit(v4(203, 0, 113, 2), true));
        let _heavy_too = admitted(pool.admit(v4(203, 0, 113, 3), true));
        // Another network, holding nothing, takes the heaviest network's oldest.
        let _light = admitted(pool.admit(v4(198, 51, 100, 1), true));
        assert!(is_displaced(&mut heavy_oldest));
        // At two to one, another place would only swap which network holds
        // more, and the heavier network cannot grow at all.
        assert!(matches!(
            pool.admit(v4(198, 51, 100, 2), true),
            Admission::Refused
        ));
        assert!(matches!(
            pool.admit(v4(203, 0, 113, 4), true),
            Admission::Refused
        ));
        assert_eq!(pool.len(), 3);
    }

    #[test]
    fn an_ipv4_mapped_peer_shares_its_ipv4_network() {
        let mapped = IpAddr::V6(Ipv4Addr::new(203, 0, 113, 9).to_ipv6_mapped());
        assert_eq!(Network::of(mapped), Network::of(v4(203, 0, 113, 1)));
        let site = |last: u16| IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0x1, 0xff, 0, 0, 0, last));
        assert_eq!(Network::of(site(1)), Network::of(site(2)));
        assert_ne!(
            Network::of(site(1)),
            Network::of(IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0x2, 0, 0, 0, 0, 1)))
        );
    }

    #[test]
    fn releasing_an_entry_frees_its_place() {
        let pool = PendingPool::with_capacity(1);
        let held = admitted(pool.admit(v4(192, 0, 2, 1), false));
        drop(held);
        assert_eq!(pool.len(), 0);
        let _next = admitted(pool.admit(v4(198, 51, 100, 1), false));
        assert_eq!(pool.len(), 1);
    }
}
