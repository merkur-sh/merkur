//! Reachability shared by the connections one application holds to one host.
//!
//! A connection whose probe timer has backed off waits `2^pto_count` probe
//! timeouts before it tests its path again, and only an acknowledgment resets
//! that backoff (RFC 9002 §6.2.1). An authenticated ack-eliciting packet that
//! any member receives proves the host reachable now, so every backed-off
//! sibling sends its probe at once instead of waiting out its own backoff. A
//! verified stateless reset proves the host lost connection state, so every
//! sibling sends one ack-eliciting packet to learn whether its own state went
//! with it.
//!
//! The receive path reads one word while no sibling is backed off. A request is
//! a bit its member's own driver consumes: no connection ever locks another.
use std::{
    fmt,
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    task::Waker,
};

use thiserror::Error;

/// Members one group holds: an application's few routing labels to a host,
/// each overlapping its replacement, fit many times over.
const MAX_MEMBERS: usize = 32;
/// A request word holds a probe bit per member below this shift and a
/// verification bit per member above it.
const VERIFY_SHIFT: u32 = 32;

/// The connections one application holds to one peer host.
///
/// Membership is a claim about the peer's host, not its path: a caller joins
/// only connections that reach the same host, so a packet heard on one says
/// something about every other.
#[derive(Clone)]
pub struct ProbeGroup(Arc<Inner>);

struct Inner {
    /// One bit per member whose probe timer has backed off (`pto_count > 0`).
    backed_off: AtomicU32,
    /// Outstanding requests: a probe bit and a verification bit per member.
    requests: AtomicU64,
    members: Mutex<Members>,
}

struct Members {
    occupied: u32,
    /// Each member's driver, woken after a sibling sets its request bit.
    wakers: [Option<Waker>; MAX_MEMBERS],
}

/// Why a connection could not join a group.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum ProbeGroupError {
    /// A closed connection has nothing left to probe.
    #[error("probe group member is closed")]
    Closed,
    /// Every member slot is held by a live connection.
    #[error("probe group is full")]
    Full,
}

impl ProbeGroup {
    /// A group with no members.
    pub fn new() -> Self {
        Self(Arc::new(Inner {
            backed_off: AtomicU32::new(0),
            requests: AtomicU64::new(0),
            members: Mutex::new(Members {
                occupied: 0,
                wakers: Default::default(),
            }),
        }))
    }

    pub(super) fn join(&self) -> Result<Member, ProbeGroupError> {
        let mut members = self.0.members.lock().expect("probe group poisoned");
        let free = !members.occupied;
        if free == 0 {
            return Err(ProbeGroupError::Full);
        }
        let bit = 1 << free.trailing_zeros();
        members.occupied |= bit;
        // A departed predecessor on this slot leaves nothing a successor owes.
        self.0.requests.fetch_and(!request_mask(bit), Ordering::Relaxed);
        Ok(Member {
            group: self.clone(),
            bit,
            backed_off: false,
            waker: None,
        })
    }

    /// Set `requests` for `members` and wake their drivers outside the lock,
    /// since a waker may run its own connection's driver inline.
    fn request(&self, requests: u64, members: u32) {
        self.0.requests.fetch_or(requests, Ordering::Release);
        let mut wake: [Option<Waker>; MAX_MEMBERS] = Default::default();
        {
            let guard = self.0.members.lock().expect("probe group poisoned");
            let mut pending = members & guard.occupied;
            while pending != 0 {
                let index = pending.trailing_zeros() as usize;
                pending &= pending - 1;
                wake[index].clone_from(&guard.wakers[index]);
            }
        }
        for waker in wake.into_iter().flatten() {
            waker.wake();
        }
    }
}

impl Default for ProbeGroup {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for ProbeGroup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProbeGroup")
            .field("backed_off", &self.0.backed_off.load(Ordering::Relaxed))
            .finish()
    }
}

/// Both request bits of the member whose slot is `bit`.
fn request_mask(bit: u32) -> u64 {
    u64::from(bit) | u64::from(bit) << VERIFY_SHIFT
}

/// One connection's slot in its group.
pub(super) struct Member {
    group: ProbeGroup,
    bit: u32,
    /// The state last published into the group's word.
    backed_off: bool,
    /// The driver last registered, so an unchanged one takes no lock.
    waker: Option<Waker>,
}

/// What siblings asked this member's driver to send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Request {
    /// A sibling's verified stateless reset: send one ack-eliciting packet even
    /// with nothing in flight.
    pub(super) verify: bool,
}

impl Member {
    pub(super) fn is_in(&self, group: &ProbeGroup) -> bool {
        Arc::ptr_eq(&self.group.0, &group.0)
    }

    /// Publish whether this connection's probe timer has backed off. Touches
    /// the shared word only on a change.
    pub(super) fn set_backed_off(&mut self, backed_off: bool) {
        if std::mem::replace(&mut self.backed_off, backed_off) == backed_off {
            return;
        }
        if backed_off {
            self.group.0.backed_off.fetch_or(self.bit, Ordering::Release);
        } else {
            self.group
                .0
                .backed_off
                .fetch_and(!self.bit, Ordering::Release);
        }
    }

    /// This connection authenticated an ack-eliciting packet: its host is
    /// reachable now. One relaxed load while no sibling is backed off.
    pub(super) fn reachable(&self) {
        let siblings = self.group.0.backed_off.load(Ordering::Relaxed) & !self.bit;
        if siblings != 0 {
            self.group.request(u64::from(siblings), siblings);
        }
    }

    /// This connection received a verified stateless reset: its host lost
    /// connection state, and every sibling should learn whether it did too.
    pub(super) fn reset(&self) {
        let siblings = {
            let members = self.group.0.members.lock().expect("probe group poisoned");
            members.occupied & !self.bit
        };
        if siblings != 0 {
            self.group
                .request(u64::from(siblings) << VERIFY_SHIFT, siblings);
        }
    }

    /// Take what siblings asked of this connection, if anything.
    pub(super) fn take_request(&self) -> Option<Request> {
        let mask = request_mask(self.bit);
        let requests = &self.group.0.requests;
        if requests.load(Ordering::Relaxed) & mask == 0 {
            return None;
        }
        let taken = requests.fetch_and(!mask, Ordering::Acquire) & mask;
        (taken != 0).then_some(Request {
            verify: taken >> VERIFY_SHIFT != 0,
        })
    }

    /// Register the driver that consumes this member's requests.
    pub(super) fn register(&mut self, waker: &Waker) {
        if self
            .waker
            .as_ref()
            .is_some_and(|known| known.will_wake(waker))
        {
            return;
        }
        self.waker = Some(waker.clone());
        let index = self.bit.trailing_zeros() as usize;
        let mut members = self.group.0.members.lock().expect("probe group poisoned");
        members.wakers[index] = Some(waker.clone());
    }
}

impl Drop for Member {
    fn drop(&mut self) {
        let inner = &self.group.0;
        inner.backed_off.fetch_and(!self.bit, Ordering::Release);
        let index = self.bit.trailing_zeros() as usize;
        let mut members = inner.members.lock().expect("probe group poisoned");
        members.occupied &= !self.bit;
        members.wakers[index] = None;
        inner
            .requests
            .fetch_and(!request_mask(self.bit), Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::task::Wake;

    struct Count(AtomicUsize);
    impl Wake for Count {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn a_packet_heard_asks_only_backed_off_siblings_and_wakes_them() {
        let group = ProbeGroup::new();
        let heard = group.join().unwrap();
        let mut idle = group.join().unwrap();
        let mut waiting = group.join().unwrap();
        let wakes = Arc::new(Count(AtomicUsize::new(0)));
        waiting.register(&Waker::from(Arc::clone(&wakes)));
        idle.register(&Waker::from(Arc::new(Count(AtomicUsize::new(0)))));

        heard.reachable();
        assert_eq!(waiting.take_request(), None, "nobody was backed off");

        waiting.set_backed_off(true);
        heard.reachable();
        assert_eq!(wakes.0.load(Ordering::Relaxed), 1);
        assert_eq!(waiting.take_request(), Some(Request { verify: false }));
        assert_eq!(waiting.take_request(), None, "a request is taken once");
        assert_eq!(idle.take_request(), None);

        // A member's own packet never asks itself.
        waiting.reachable();
        assert_eq!(waiting.take_request(), None);

        waiting.set_backed_off(false);
        heard.reachable();
        assert_eq!(waiting.take_request(), None);
    }

    #[test]
    fn a_reset_asks_every_sibling_to_verify_and_a_departed_slot_starts_clean() {
        let group = ProbeGroup::new();
        let reset = group.join().unwrap();
        let sibling = group.join().unwrap();
        let other = group.join().unwrap();
        reset.reset();
        assert_eq!(sibling.take_request(), Some(Request { verify: true }));
        assert_eq!(reset.take_request(), None);
        drop(other);
        let successor = group.join().unwrap();
        assert_eq!(successor.take_request(), None);
    }

    #[test]
    fn a_full_group_refuses_and_a_departure_frees_the_slot() {
        let group = ProbeGroup::new();
        let mut members: Vec<_> = (0..MAX_MEMBERS).map(|_| group.join().unwrap()).collect();
        assert_eq!(group.join().err(), Some(ProbeGroupError::Full));
        members.pop();
        assert!(group.join().is_ok());
    }
}
