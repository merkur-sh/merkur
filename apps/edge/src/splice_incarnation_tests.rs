//! Incarnation ownership follows registry membership, including half-pairs.
use super::*;

const EARLIER: &str = "AAAAAAAAAAAAAAAAAAAAAA";
const LATER: &str = "BBBBBBBBBBBBBBBBBBBBBB";
const CHURN: usize = 128;

fn metadata(registry: &SpliceRegistry) -> (usize, usize, usize) {
    let sessions = registry.read_sessions();
    let entries = &sessions.daemon_incarnations;
    for (id, known) in entries {
        assert_eq!(
            known.slots,
            sessions
                .values()
                .filter(|slot| slot.daemon_id == *id)
                .count()
        );
    }
    for slot in sessions.values().filter(|slot| slot.incarnation.is_some()) {
        assert!(entries.contains_key(&slot.daemon_id));
    }
    (
        entries.len(),
        entries
            .iter()
            .map(|(id, incarnation)| id.len() + incarnation.incarnation.len())
            .sum(),
        entries.capacity(),
    )
}

fn retired(handle: &AttachHandle, reason: RetireReason) {
    assert_eq!(
        *handle.lifecycle_rx.borrow(),
        Some(AttachmentLifecycle::Retire(reason)),
    );
    assert!(handle.datagram_rx.is_closed());
    assert!(handle.reliable_open_rx.is_closed());
    assert!(
        !handle
            .datagram_route
            .route(Frame::datagram(Bytes::from_static(b"retired")))
    );
}

async fn churn_expired_slots(expiry: usize) -> SpliceRegistry {
    let mut registry = SpliceRegistry::with_limits(1, Duration::from_secs(60));
    for index in 0..CHURN {
        registry.unpaired_ttl = Duration::from_secs(60);
        let daemon = format!("daemon-{index:04}");
        let expired = registry.attach_tunnel("expired", &daemon, EARLIER).unwrap();
        registry.unpaired_ttl = Duration::ZERO;
        match expiry {
            0 | 1 => {
                let label = if expiry == 0 { "expired" } else { "other" };
                let fresh = registry.attach_tunnel(label, &daemon, EARLIER).unwrap();
                assert_eq!(metadata(&registry).0, 1);
                registry.detach(label, Role::Daemon, fresh.attachment_id);
            }
            2 => assert_eq!(registry.prune_expired_unpaired(), 1),
            _ => assert_eq!(registry.wait_and_prune_expired_unpaired().await, 1),
        }
        retired(&expired, RetireReason::RebindWindowExpired);
    }
    registry
}

#[tokio::test]
async fn incarnation_metadata_retires_with_slots() {
    let mut retained = Vec::new();
    let mut record = |name, registry: &SpliceRegistry| {
        assert!(registry.read_sessions().is_empty());
        let snapshot = metadata(registry);
        println!(
            "{name}: entries={} string_bytes={} capacity={}",
            snapshot.0, snapshot.1, snapshot.2
        );
        retained.push(snapshot.0);
    };

    let registry = SpliceRegistry::new();
    for index in 0..CHURN {
        assert_eq!(
            registry.announce_incarnation(&format!("daemon-{index:04}"), EARLIER),
            0
        );
    }
    record("announcement_without_slots", &registry);

    let registry = SpliceRegistry::new();
    for index in 0..CHURN {
        let daemon = format!("daemon-{index:04}");
        for label in ["session", "session#bulk", "session#signaling"] {
            let browser = registry.attach(label, Role::Browser, &daemon).unwrap();
            let first = registry.attach_tunnel(label, &daemon, EARLIER).unwrap();
            let replacement = registry.attach_tunnel(label, &daemon, EARLIER).unwrap();
            registry.detach(label, Role::Daemon, first.attachment_id);
            assert!(
                browser
                    .datagram_route
                    .route(Frame::datagram(Bytes::from_static(b"live")))
            );
            registry.detach(label, Role::Daemon, replacement.attachment_id);
            assert!(registry.read_sessions().contains_key(label));
            assert_eq!(metadata(&registry).0, 1);
            registry.detach(label, Role::Browser, browser.attachment_id);
        }
    }
    record("replacement_and_exact_detach", &registry);

    let registry = SpliceRegistry::new();
    for index in 0..CHURN {
        let daemon = format!("daemon-{index:04}");
        let unknown = registry.attach("unknown", Role::Browser, &daemon).unwrap();
        let tunnel = registry.attach_tunnel("known", &daemon, EARLIER).unwrap();
        let browser = registry.attach("known", Role::Browser, &daemon).unwrap();
        registry.detach("known", Role::Daemon, tunnel.attachment_id);
        assert_eq!(registry.announce_incarnation(&daemon, LATER), 1);
        retired(&browser, RetireReason::IncarnationSuperseded);
        assert!(registry.read_sessions().contains_key("unknown"));
        assert_eq!(metadata(&registry).0, 1);
        assert_eq!(registry.announce_incarnation(&daemon, LATER), 0);
        registry.detach("unknown", Role::Browser, unknown.attachment_id);
        let first = registry.attach_tunnel("known", &daemon, EARLIER).unwrap();
        let successor = registry.attach_tunnel("known", &daemon, LATER).unwrap();
        retired(&first, RetireReason::IncarnationSuperseded);
        registry.detach("known", Role::Daemon, first.attachment_id);
        assert!(registry.read_sessions().contains_key("known"));
        registry.detach("known", Role::Daemon, successor.attachment_id);
    }
    record("announcement_and_tunnel_supersession", &registry);

    for expiry in 0..4 {
        record("expiry", &churn_expired_slots(expiry).await);
    }

    for state in [
        crate::egress_budget::BudgetState::SignalingOnly,
        crate::egress_budget::BudgetState::Stopped,
    ] {
        let registry = SpliceRegistry::new();
        for index in 0..CHURN {
            registry.apply_egress_state(crate::egress_budget::BudgetState::Open);
            let daemon = format!("daemon-{index:04}");
            let data = registry.attach_tunnel("session", &daemon, EARLIER).unwrap();
            let bulk = registry
                .attach_tunnel("session#bulk", &daemon, EARLIER)
                .unwrap();
            let signaling = registry
                .attach_tunnel("session#signaling", &daemon, EARLIER)
                .unwrap();
            registry.apply_egress_state(state);
            retired(&data, RetireReason::EgressBudget);
            retired(&bulk, RetireReason::EgressBudget);
            if state == crate::egress_budget::BudgetState::SignalingOnly {
                assert!(registry.read_sessions().contains_key("session#signaling"));
                assert_eq!(metadata(&registry).0, 1);
                assert_eq!(registry.announce_incarnation(&daemon, EARLIER), 0);
                registry.apply_egress_state(crate::egress_budget::BudgetState::Stopped);
            }
            retired(&signaling, RetireReason::EgressBudget);
        }
        record("budget_retirement", &registry);
    }
    assert_eq!(retained, vec![0; retained.len()]);
}

#[tokio::test]
async fn incarnation_metadata_preserves_live_siblings_and_admission() {
    let registry = SpliceRegistry::with_limits(3, Duration::from_secs(60));
    let browser = registry.attach("session", Role::Browser, "daemon").unwrap();
    assert_eq!(metadata(&registry).0, 0);
    assert_eq!(registry.announce_incarnation("daemon", EARLIER), 0);
    assert_eq!(metadata(&registry).0, 1);
    let first = registry
        .attach_tunnel("session", "daemon", EARLIER)
        .unwrap();
    let sibling = registry
        .attach_tunnel("session#bulk", "daemon", EARLIER)
        .unwrap();
    let other = registry
        .attach_tunnel("other", "other-daemon", EARLIER)
        .unwrap();
    assert!(matches!(
        registry.attach_tunnel("full", "refused", EARLIER),
        Err(AttachError::Capacity)
    ));
    assert!(matches!(
        registry.attach_tunnel("other", "mismatched", EARLIER),
        Err(AttachError::DaemonMismatch)
    ));
    assert_eq!(metadata(&registry).0, 2);
    registry.detach("session#bulk", Role::Daemon, sibling.attachment_id);
    assert_eq!(metadata(&registry).0, 2);
    assert_eq!(registry.announce_incarnation("daemon", LATER), 1);
    retired(&first, RetireReason::IncarnationSuperseded);
    retired(&browser, RetireReason::IncarnationSuperseded);
    assert!(registry.read_sessions().contains_key("other"));
    registry.detach("other", Role::Daemon, other.attachment_id);
    let snapshot = metadata(&registry);
    println!(
        "after_refused_admission: entries={} string_bytes={} capacity={}",
        snapshot.0, snapshot.1, snapshot.2
    );
    assert_eq!(snapshot.0, 0);
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "allocation proof; run explicitly with --ignored --nocapture"]
fn incarnation_metadata_non_target_profile() {
    for role in [Role::Browser, Role::Daemon] {
        for len in [0, 57, 1100] {
            let registry = SpliceRegistry::new();
            let browser = registry.attach("session", Role::Browser, "daemon").unwrap();
            let daemon = registry
                .attach_tunnel("session", "daemon", EARLIER)
                .unwrap();
            let (source, mut destination) = if role == Role::Browser {
                (browser, daemon)
            } else {
                (daemon, browser)
            };
            let payload = Bytes::from(vec![0x5a; len]);
            let mut route = || {
                assert!(
                    source
                        .datagram_route
                        .route(Frame::datagram(payload.clone()))
                );
                let received = destination.datagram_rx.try_recv().unwrap();
                assert_eq!(received.datagrams.payloads()[0], payload);
                assert_eq!(received.datagrams.payloads()[0].as_ptr(), payload.as_ptr());
            };
            for _ in 0..512 {
                route();
            }
            let (_, tally) = crate::profile_support::measured(|| {
                for _ in 0..4096 {
                    route();
                }
            });
            println!(
                "forward role={role:?} len={len} operations=4096 allocations={} bytes={} payload_copies=0",
                tally.allocations, tally.bytes
            );
            assert_eq!(tally, crate::profile_support::Tally::default());
            let (_, tally) = crate::profile_support::measured(|| {
                for _ in 0..4096 {
                    assert_eq!(registry.announce_incarnation("daemon", EARLIER), 0);
                }
            });
            println!(
                "same_incarnation operations=4096 allocations={} bytes={}",
                tally.allocations, tally.bytes
            );
            assert_eq!(tally, crate::profile_support::Tally::default());
        }
    }
}
