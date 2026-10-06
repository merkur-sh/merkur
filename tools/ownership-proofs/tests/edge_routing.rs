//! Execute the production routing and membership methods with Loom synchronization.
//! Only transport/mailbox adapters are replaced. Each admission asserts that its
//! exact source and destination still live; there is no modeled reimplementation
//! of source validation, lock custody, replacement, detach, retirement or Drop.

use loom::sync::{Arc, Mutex};
use std::sync::atomic::Ordering as AtomicOrdering;
use std::time::{Duration, Instant};

extern crate self as wtransport;
pub mod quinn {
    pub struct VarInt;
    impl VarInt {
        pub fn from_u32(_: u32) -> Self {
            Self
        }
    }
}
mod relay {
    pub const EGRESS_BUDGET_CLOSE_CODE: u32 = 0;
    pub const EGRESS_BUDGET_CLOSE_REASON: &[u8] = b"budget";
}
mod metrics {
    use std::sync::atomic::AtomicU64;
    static DROPS: AtomicU64 = AtomicU64::new(0);
    pub fn route_drop_counter(_: super::Role) -> &'static AtomicU64 {
        &DROPS
    }
}

struct RwLock<T>(loom::sync::RwLock<T>);
impl<T> RwLock<T> {
    fn new(value: T) -> Self {
        Self(loom::sync::RwLock::new(value))
    }
    fn read(&self) -> loom::sync::RwLockReadGuard<'_, T> {
        self.0.read().unwrap()
    }
    fn write(&self) -> loom::sync::RwLockWriteGuard<'_, T> {
        self.0.write().unwrap()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AttachmentId(u64);
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Browser,
    Daemon,
}
impl Role {
    fn peer(self) -> Self {
        match self {
            Self::Browser => Self::Daemon,
            Self::Daemon => Self::Browser,
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum RetireReason {
    EgressBudget,
    RebindWindowExpired,
}
#[derive(Clone, Copy)]
enum AttachmentLifecycle {
    CounterpartAttached {
        attachment_id: AttachmentId,
    },
    CounterpartDetached {
        attachment_id: AttachmentId,
        rebind_window_remaining_ms: u64,
    },
}
#[derive(Default)]
struct Mailbox {
    retired: loom::sync::atomic::AtomicBool,
    admitted: Mutex<Vec<AttachmentId>>,
}
pub struct Frame {
    datagrams: [(); 1],
    source: Arc<Mailbox>,
}
struct Transport;
impl Transport {
    fn close(&self, _: quinn::VarInt, _: &[u8]) {}
}
struct PeerSink {
    role: Role,
    attachment_id: AttachmentId,
    mailbox: Arc<Mailbox>,
    transport: Option<Transport>,
}
impl PeerSink {
    fn reliable_destination(&self) -> AttachmentId {
        self.attachment_id
    }
    fn signal(&self, event: AttachmentLifecycle) {
        // Record the adapter arguments without adding scheduler synchronization.
        match event {
            AttachmentLifecycle::CounterpartAttached { attachment_id } => {
                let _ = attachment_id;
            }
            AttachmentLifecycle::CounterpartDetached {
                attachment_id,
                rebind_window_remaining_ms,
            } => {
                let _ = (attachment_id, rebind_window_remaining_ms);
            }
        }
    }
    fn forward_datagram(&self, frame: Frame) -> bool {
        assert!(
            !frame.source.retired.load(AtomicOrdering::Relaxed),
            "admitted retired source"
        );
        assert!(
            !self.mailbox.retired.load(AtomicOrdering::Relaxed),
            "admitted retired destination"
        );
        self.mailbox
            .admitted
            .lock()
            .unwrap()
            .push(self.attachment_id);
        true
    }
    fn retire(self, _: RetireReason) {}
}
impl Drop for PeerSink {
    fn drop(&mut self) {
        self.mailbox.retired.store(true, AtomicOrdering::Relaxed);
    }
}
struct Destination;
impl Destination {
    fn send_replace(&self, _: Option<AttachmentId>) {}
}

include!(concat!(env!("OUT_DIR"), "/routing.rs"));
struct SessionSlot {
    peers: Arc<RwLock<SessionPeers>>,
    unpaired_since: Option<Instant>,
    browser_destination: Destination,
    daemon_destination: Destination,
}
impl SessionSlot {
    fn destination_for(&self, role: Role) -> &Destination {
        match role {
            Role::Browser => &self.browser_destination,
            Role::Daemon => &self.daemon_destination,
        }
    }
}
include!(concat!(env!("OUT_DIR"), "/membership.rs"));

fn peer(role: Role, id: u64) -> (PeerSink, Arc<Mailbox>) {
    let mailbox = Arc::new(Mailbox::default());
    (
        PeerSink {
            role,
            attachment_id: AttachmentId(id),
            mailbox: mailbox.clone(),
            transport: Some(Transport),
        },
        mailbox,
    )
}
fn fixture() -> (SessionSlot, Arc<DatagramRoute>, Arc<Mailbox>, Arc<Mailbox>) {
    let (browser, source) = peer(Role::Browser, 1);
    let (daemon, destination) = peer(Role::Daemon, 2);
    let peers = Arc::new(RwLock::new(SessionPeers {
        browser: Some(browser),
        daemon: Some(daemon),
    }));
    let route = Arc::new(DatagramRoute {
        peers: peers.clone(),
        from_role: Role::Browser,
        attachment_id: AttachmentId(1),
    });
    (
        SessionSlot {
            peers,
            unpaired_since: None,
            browser_destination: Destination,
            daemon_destination: Destination,
        },
        route,
        source,
        destination,
    )
}
fn frame(source: &Arc<Mailbox>) -> Frame {
    Frame {
        datagrams: [()],
        source: source.clone(),
    }
}

#[test]
fn source_replacement_never_admits_the_retired_writer() {
    loom::model(|| {
        let (mut slot, route, source, _) = fixture();
        let sending = route.clone();
        let owned = source.clone();
        let sender = loom::thread::spawn(move || {
            sending.route(frame(&owned));
        });
        let replacement = loom::thread::spawn(move || {
            let (next, _) = peer(Role::Browser, 3);
            let (old, paired, _) = slot.set(next);
            assert!(paired);
            drop(old);
            assert!(!route.route(frame(&source)));
        });
        sender.join().unwrap();
        replacement.join().unwrap();
    });
}
#[test]
fn destination_replacement_keeps_selection_and_admission_atomic() {
    loom::model(|| {
        let (mut slot, route, source, _) = fixture();
        let sender = loom::thread::spawn(move || {
            route.route(frame(&source));
        });
        let replacement = loom::thread::spawn(move || {
            let (next, _) = peer(Role::Daemon, 3);
            drop(slot.set(next).0);
            // Keep the slot live through the competing admission.
            slot
        });
        sender.join().unwrap();
        drop(replacement.join().unwrap());
    });
}
#[test]
fn retiring_the_pair_revokes_retained_route_handles() {
    for reason in [
        RetireReason::EgressBudget,
        RetireReason::RebindWindowExpired,
    ] {
        loom::model(move || {
            let (slot, route, source, _) = fixture();
            let sending = route.clone();
            let owned = source.clone();
            let sender = loom::thread::spawn(move || {
                sending.route(frame(&owned));
            });
            let retiring = loom::thread::spawn(move || {
                slot.retire(reason);
                slot
            });
            sender.join().unwrap();
            let slot = retiring.join().unwrap();
            assert!(!route.route(frame(&source)));
            drop(slot);
        });
    }
}
#[test]
fn stale_detach_cannot_remove_a_successor_attachment() {
    loom::model(|| {
        let (mut slot, _, _, _) = fixture();
        let (next, source) = peer(Role::Browser, 3);
        drop(slot.set(next).0);
        let route = DatagramRoute {
            peers: slot.peers.clone(),
            from_role: Role::Browser,
            attachment_id: AttachmentId(3),
        };
        assert!(!slot.detach(Role::Browser, AttachmentId(1), Duration::from_secs(1)));
        assert!(route.route(frame(&source)));
        assert!(!slot.detach(Role::Browser, AttachmentId(3), Duration::from_secs(1)));
        assert!(!route.route(frame(&source)));
    });
}
#[test]
fn slot_drop_revokes_old_handles_before_label_reuse() {
    loom::model(|| {
        let (slot, route, source, _) = fixture();
        drop(slot);
        let (_successor_slot, successor_route, successor_source, _) = fixture();
        assert!(!route.route(frame(&source)));
        assert!(successor_route.route(frame(&successor_source)));
    });
}
