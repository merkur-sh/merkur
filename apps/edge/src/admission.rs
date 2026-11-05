//! Fair admission to the edge's bounded pools.
//!
//! A [`FairPool`] holds a fixed number of places and shares them between
//! owners: no owner can keep another below an equal share, however many places
//! it asks for. The edge runs two:
//!
//! - **Pending connections**, owned by source [`Network`]. Until a routing
//!   preface's ticket verifies, all the edge knows of a peer is the address its
//!   packets come from, and the handshake, the WebTransport request and the
//!   preface are work it does for anyone. This pool holds that work apart from
//!   the sessions tickets admit, so a flood can only exhaust the pool. While it
//!   has room every attempt enters, and no dial pays a round trip. Full, an
//!   attempt from an unproven address is answered with a QUIC Retry. That is
//!   stateless: a spoofed source never holds a place, and a real one comes
//!   back proven one round trip later.
//! - **Candidate proof bridges**, owned by the ticket's tenant.
//!
//! Full, a proven request displaces the oldest unproven place, which may be
//! spoofed. With none left, it displaces the oldest place of the owner holding
//! the most, provided its own owner still holds fewer afterwards; otherwise it
//! is refused.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::convert::Infallible;
use std::hash::Hash;
use std::net::IpAddr;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::oneshot;

/// Connections between their first packet and a verified ticket. A browser
/// session dials three lanes at once; this is room for hundreds of sessions
/// starting within one handshake.
pub(crate) const PENDING_CAPACITY: usize = 1024;

/// The owner of a pending connection: an IPv4 /24 or an IPv6 /48, the largest
/// block one site is commonly assigned, so one site's addresses count as one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Network {
    V4([u8; 3]),
    V6([u8; 6]),
}

impl Network {
    pub(crate) fn of(address: IpAddr) -> Self {
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

pub(crate) enum Admission<K: Copy + Eq + Hash> {
    Admitted(Place<K>),
    /// Answer with a QUIC Retry: the pool is full and the request unproven.
    Retry,
    /// The pool is full and the owner holds its share.
    Refused,
}

pub(crate) struct FairPool<K> {
    capacity: usize,
    state: Arc<Mutex<PoolState<K>>>,
}

impl<K> Clone for FairPool<K> {
    fn clone(&self) -> Self {
        Self {
            capacity: self.capacity,
            state: Arc::clone(&self.state),
        }
    }
}

struct PoolState<K> {
    next_id: u64,
    len: usize,
    /// Places no proof stands behind, oldest first.
    unproven: BTreeMap<u64, K>,
    /// Each owner's places, oldest first.
    owners: HashMap<K, VecDeque<Entry>>,
}

struct Entry {
    id: u64,
    /// Dropped on displacement, which completes the holder's receiver.
    _displace: oneshot::Sender<Infallible>,
}

/// One holder's place in a pool, released on drop.
pub(crate) struct Place<K: Copy + Eq + Hash> {
    id: u64,
    owner: K,
    state: Arc<Mutex<PoolState<K>>>,
    displaced: oneshot::Receiver<Infallible>,
}

impl<K: Copy + Eq + Hash> Place<K> {
    /// Completes once a later request took this place.
    pub(crate) async fn displaced(&mut self) {
        match (&mut self.displaced).await {
            Ok(never) => match never {},
            Err(_dropped) => {}
        }
    }
}

impl<K: Copy + Eq + Hash> Drop for Place<K> {
    fn drop(&mut self) {
        self.state.lock().remove(self.owner, self.id);
    }
}

impl<K: Copy + Eq + Hash> FairPool<K> {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        assert!(capacity > 0, "an empty pool admits nothing");
        Self {
            capacity,
            state: Arc::new(Mutex::new(PoolState {
                next_id: 0,
                len: 0,
                unproven: BTreeMap::new(),
                owners: HashMap::new(),
            })),
        }
    }

    /// Admit a request of `owner`. An unproven request, which may be forged,
    /// enters only while the pool has room.
    pub(crate) fn admit(&self, owner: K, proven: bool) -> Admission<K> {
        let mut state = self.state.lock();
        if state.len >= self.capacity {
            if !proven {
                return Admission::Retry;
            }
            if !state.displace_oldest_unproven() && !state.displace_for(owner) {
                return Admission::Refused;
            }
        }
        let id = state.next_id;
        state.next_id += 1;
        let (displace, displaced) = oneshot::channel();
        state.owners.entry(owner).or_default().push_back(Entry {
            id,
            _displace: displace,
        });
        if !proven {
            state.unproven.insert(id, owner);
        }
        state.len += 1;
        Admission::Admitted(Place {
            id,
            owner,
            state: Arc::clone(&self.state),
            displaced,
        })
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.state.lock().len
    }
}

impl<K: Copy + Eq + Hash> PoolState<K> {
    fn remove(&mut self, owner: K, id: u64) {
        let Some(entries) = self.owners.get_mut(&owner) else {
            return;
        };
        let Some(index) = entries.iter().position(|entry| entry.id == id) else {
            return;
        };
        entries.remove(index);
        if entries.is_empty() {
            self.owners.remove(&owner);
        }
        self.unproven.remove(&id);
        self.len -= 1;
    }

    fn displace_oldest_unproven(&mut self) -> bool {
        let Some((id, owner)) = self.unproven.pop_first() else {
            return false;
        };
        self.remove(owner, id);
        true
    }

    /// Make room for `owner` from the owner holding the most, if that leaves
    /// `owner` still holding fewer.
    fn displace_for(&mut self, owner: K) -> bool {
        let own = self.owners.get(&owner).map_or(0, VecDeque::len);
        let Some((heaviest, held)) = self
            .owners
            .iter()
            .map(|(owner, entries)| (*owner, entries.len()))
            .max_by_key(|(_, held)| *held)
        else {
            return false;
        };
        if own + 1 >= held {
            return false;
        }
        let Some(oldest) = self
            .owners
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

    fn v4(a: u8, b: u8, c: u8, d: u8) -> Network {
        Network::of(IpAddr::V4(Ipv4Addr::new(a, b, c, d)))
    }

    fn admitted(admission: Admission<Network>) -> Place<Network> {
        match admission {
            Admission::Admitted(place) => place,
            Admission::Retry => panic!("expected admission, got a retry"),
            Admission::Refused => panic!("expected admission, got a refusal"),
        }
    }

    fn is_displaced(place: &mut Place<Network>) -> bool {
        place
            .displaced
            .try_recv()
            .is_err_and(|error| matches!(error, oneshot::error::TryRecvError::Closed))
    }

    #[test]
    fn a_pool_with_room_admits_unproven_requests_without_a_retry() {
        let pool = FairPool::with_capacity(2);
        let _first = admitted(pool.admit(v4(192, 0, 2, 1), false));
        let _second = admitted(pool.admit(v4(192, 0, 2, 1), false));
        assert_eq!(pool.len(), 2);
    }

    #[test]
    fn a_full_pool_answers_an_unproven_request_with_a_retry() {
        let pool = FairPool::with_capacity(1);
        let _held = admitted(pool.admit(v4(192, 0, 2, 1), false));
        assert!(matches!(
            pool.admit(v4(198, 51, 100, 1), false),
            Admission::Retry
        ));
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn a_proven_request_displaces_the_oldest_unproven_place() {
        let pool = FairPool::with_capacity(2);
        let mut oldest = admitted(pool.admit(v4(203, 0, 113, 1), false));
        let mut newer = admitted(pool.admit(v4(203, 0, 113, 2), false));
        let _proven = admitted(pool.admit(v4(198, 51, 100, 1), true));
        assert!(is_displaced(&mut oldest));
        assert!(!is_displaced(&mut newer));
        assert_eq!(pool.len(), 2);
    }

    #[test]
    fn proven_places_are_shared_by_owner() {
        let pool = FairPool::with_capacity(3);
        let mut heavy_oldest = admitted(pool.admit(v4(203, 0, 113, 1), true));
        let _heavy = admitted(pool.admit(v4(203, 0, 113, 2), true));
        let _heavy_too = admitted(pool.admit(v4(203, 0, 113, 3), true));
        // Another owner, holding nothing, takes the heaviest owner's oldest.
        let _light = admitted(pool.admit(v4(198, 51, 100, 1), true));
        assert!(is_displaced(&mut heavy_oldest));
        // At two to one, another place would only swap which owner holds
        // more, and the heavier owner cannot grow at all.
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
        assert_eq!(Network::of(mapped), v4(203, 0, 113, 1));
        let site = |last: u16| IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0x1, 0xff, 0, 0, 0, last));
        assert_eq!(Network::of(site(1)), Network::of(site(2)));
        assert_ne!(
            Network::of(site(1)),
            Network::of(IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0x2, 0, 0, 0, 0, 1)))
        );
    }

    #[test]
    fn releasing_a_place_frees_it() {
        let pool = FairPool::with_capacity(1);
        let held = admitted(pool.admit(v4(192, 0, 2, 1), false));
        drop(held);
        assert_eq!(pool.len(), 0);
        let _next = admitted(pool.admit(v4(198, 51, 100, 1), false));
        assert_eq!(pool.len(), 1);
    }
}
