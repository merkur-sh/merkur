//! Lifecycle and contention coverage for the production attachment-local route.
use super::*;

fn packet() -> Frame {
    Frame::datagram(Bytes::from_static(b"opaque"))
}

#[tokio::test]
async fn routing_does_not_wait_for_registry_or_unrelated_session_writers() {
    let registry = SpliceRegistry::new();
    let source = registry.attach("active", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
    let mut destination = registry.attach("active", Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
    let unrelated = registry.attach("other", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
    let registry_guard = registry.write_sessions();
    let unrelated_guard = unrelated.datagram_route.peers.write();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker =
        std::thread::spawn(move || tx.send(source.datagram_route.route(packet())).unwrap());
    let admitted = rx.recv_timeout(Duration::from_secs(2));
    // Release before asserting, so a regression fails rather than deadlocking.
    drop(unrelated_guard);
    drop(registry_guard);
    worker.join().unwrap();
    assert_eq!(admitted, Ok(true));
    assert_eq!(destination.datagram_rx.try_recv().unwrap(), packet());
}

#[tokio::test]
async fn retained_routes_do_not_keep_removed_slots_or_senders_alive() {
    for role in [Role::Browser, Role::Daemon] {
        let registry = SpliceRegistry::new();
        let mut source = registry.attach("reused", role, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
        let mut destination = registry.attach("reused", role.peer(), crate::attach_ticket::TEST_DAEMON_ID).unwrap();
        registry.detach("reused", role, source.attachment_id);
        registry.detach("reused", role.peer(), destination.attachment_id);
        assert!(registry.read_sessions().is_empty());
        assert!(source.datagram_rx.is_closed());
        assert!(destination.datagram_rx.is_closed());
        source.counterpart_destinations.borrow_and_update();
        assert!(source.counterpart_destinations.changed().await.is_err());
        destination.counterpart_destinations.borrow_and_update();
        assert!(
            destination
                .counterpart_destinations
                .changed()
                .await
                .is_err()
        );
        let fresh_source = registry.attach("reused", role, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
        let mut fresh_destination = registry.attach("reused", role.peer(), crate::attach_ticket::TEST_DAEMON_ID).unwrap();
        assert!(!source.datagram_route.route(packet()));
        assert!(!destination.datagram_route.route(packet()));
        assert!(fresh_source.datagram_route.route(packet()));
        assert_eq!(fresh_destination.datagram_rx.try_recv().unwrap(), packet());
        assert!(fresh_destination.datagram_rx.try_recv().is_err());
    }
}

#[tokio::test]
async fn registry_shutdown_clears_peers_even_when_routes_survive() {
    let registry = SpliceRegistry::new();
    let browser = registry.attach("shutdown", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
    let daemon = registry.attach("shutdown", Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
    drop(registry);
    assert!(!browser.datagram_route.route(packet()));
    assert!(!daemon.datagram_route.route(packet()));
    assert!(browser.datagram_rx.is_closed());
    assert!(daemon.datagram_rx.is_closed());
    assert!(browser.reliable_open_rx.is_closed());
    assert!(daemon.reliable_open_rx.is_closed());
}

#[tokio::test]
async fn every_expiry_path_invalidates_retained_routes_and_names_retirement() {
    for role in [Role::Browser, Role::Daemon] {
        // Exact-label admission, capacity admission and deadline pruning all
        // retire the same authoritative peer state before freeing membership.
        for expiry_path in 0..3 {
            let mut registry = SpliceRegistry::with_limits(1, Duration::from_secs(60));
            let mut expired = registry.attach("expired", role, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
            registry.unpaired_ttl = Duration::ZERO;
            match expiry_path {
                0 => {
                    registry.attach("expired", role.peer(), crate::attach_ticket::TEST_DAEMON_ID).unwrap();
                }
                1 => {
                    registry.attach("other", role.peer(), crate::attach_ticket::TEST_DAEMON_ID).unwrap();
                }
                _ => {
                    assert_eq!(registry.wait_and_prune_expired_unpaired().await, 1);
                }
            }
            assert_eq!(
                *expired.lifecycle_rx.borrow(),
                Some(AttachmentLifecycle::Retire(
                    RetireReason::RebindWindowExpired
                ))
            );
            assert!(expired.datagram_rx.is_closed());
            assert!(expired.reliable_open_rx.is_closed());
            assert!(expired.counterpart_destinations.changed().await.is_err());
            assert!(!expired.datagram_route.route(packet()));
        }
    }
}

#[tokio::test]
async fn concurrent_replacement_fences_both_source_and_destination() {
    for role in [Role::Browser, Role::Daemon] {
        let registry = SpliceRegistry::new();
        let source = registry.attach("race", role, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
        let mut destination = registry.attach("race", role.peer(), crate::attach_ticket::TEST_DAEMON_ID).unwrap();
        let begin = Arc::new(std::sync::Barrier::new(2));
        let seated = Arc::new(std::sync::Barrier::new(2));
        let worker_begin = Arc::clone(&begin);
        let worker_seated = Arc::clone(&seated);
        let worker = std::thread::spawn(move || {
            worker_begin.wait();
            // May linearize on either side of destination replacement.
            assert!(source.datagram_route.route(packet()));
            worker_seated.wait();
            // Replacement has completed: it must be the sole destination now.
            assert!(
                source
                    .datagram_route
                    .route(Frame::datagram(Bytes::from_static(b"after")))
            );
            source
        });
        begin.wait();
        let mut replacement = registry.attach("race", role.peer(), crate::attach_ticket::TEST_DAEMON_ID).unwrap();
        drop(replacement.replaced.take());
        seated.wait();
        let source = worker.join().unwrap();
        let mut received = Vec::new();
        while let Ok(frame) = destination.datagram_rx.try_recv() {
            assert_eq!(frame, packet());
            received.push(frame);
        }
        while let Ok(frame) = replacement.datagram_rx.try_recv() {
            received.push(frame);
        }
        assert_eq!(
            received,
            vec![
                packet(),
                Frame::datagram(Bytes::from_static(b"after"))
            ]
        );
        let new_source = registry.attach("race", role, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
        let worker = std::thread::spawn(move || {
            for _ in 0..1_000 {
                assert!(!source.datagram_route.route(packet()));
            }
        });
        registry.detach("race", role.peer(), destination.attachment_id);
        assert!(new_source.datagram_route.route(packet()));
        worker.join().unwrap();
        assert_eq!(replacement.datagram_rx.try_recv().unwrap(), packet());
        assert!(replacement.datagram_rx.try_recv().is_err());
    }
}

/// Former registry-wide routing transaction, confined to this benchmark. Peers
/// live directly in the map as before: no extra session lock biases the control.
fn global_route(
    sessions: &RwLock<HashMap<String, SessionPeers>>,
    label: &str,
    source: AttachmentId,
    frame: Frame,
) -> bool {
    let sessions = sessions.read();
    let Some(peers) = sessions.get(label) else {
        return false;
    };
    if !peers
        .sink_for(Role::Browser)
        .is_some_and(|peer| peer.attachment_id == source)
    {
        return false;
    }
    match peers.sink_for(Role::Daemon) {
        Some(peer) if peer.forward_datagram(frame) => true,
        Some(_) => {
            metrics::route_drop_counter(Role::Browser).fetch_add(1, AtomicOrdering::Relaxed);
            false
        }
        None => false,
    }
}

#[test]
#[ignore = "release-mode routing A/B; run alone with --nocapture"]
fn profile_session_local_routing() {
    const ITERATIONS: usize = 100_000;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    // Attachments are made inside the runtime's context, as the relay makes them.
    let _context = runtime.enter();
    for session_count in [8, 1024] {
        for threads in [1, 4, 8] {
            let registry = SpliceRegistry::new();
            let global = RwLock::new(HashMap::with_capacity(session_count));
            let mut lanes = Vec::new();
            for index in 0..session_count {
                let label = format!("session-{index:08}");
                let browser = registry
                    .attach(&label, Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
                    .unwrap();
                let daemon = registry
                    .attach(&label, Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
                    .unwrap();
                let (old_browser, old_browser_rx) =
                    PeerSink::new(Role::Browser, browser.attachment_id);
                let (old_daemon, old_daemon_rx) = PeerSink::new(Role::Daemon, daemon.attachment_id);
                global.write().insert(
                    label.clone(),
                    SessionPeers {
                        browser: Some(old_browser),
                        daemon: Some(old_daemon),
                    },
                );
                lanes.push((label, browser, daemon, old_browser_rx, old_daemon_rx));
            }
            // ABBA/BAAB repeated: four samples of each arm per round pair.
            for round in 0..8 {
                let local = [false, true, true, false, true, false, false, true][round];
                let barrier = std::sync::Barrier::new(threads);
                let samples = std::thread::scope(|scope| {
                    let mut workers = Vec::new();
                    let width = session_count / threads;
                    for chunk in lanes.chunks_mut(width) {
                        let barrier = &barrier;
                        let global = &global;
                        workers.push(scope.spawn(move || {
                            let step = |index: usize,
                                        chunk: &mut [(
                                String,
                                AttachHandle,
                                AttachHandle,
                                PeerReceivers,
                                PeerReceivers,
                            )]| {
                                let (label, browser, daemon, _, old_daemon) =
                                    &mut chunk[index % width];
                                let frame = packet();
                                let pointer = frame.datagrams.payloads()[0].as_ptr();
                                let received = if local {
                                    assert!(browser.datagram_route.route(frame));
                                    daemon.datagram_rx.try_recv().unwrap()
                                } else {
                                    assert!(global_route(
                                        global,
                                        label,
                                        browser.attachment_id,
                                        frame
                                    ));
                                    old_daemon.datagram_rx.try_recv().unwrap()
                                };
                                assert_eq!(received.datagrams.payloads()[0].as_ptr(), pointer);
                                std::hint::black_box(received);
                            };
                            for index in 0..10_000 {
                                step(index, chunk);
                            }
                            barrier.wait();
                            let start = Instant::now();
                            for index in 0..ITERATIONS {
                                step(index, chunk);
                            }
                            start.elapsed().as_nanos() as f64 / ITERATIONS as f64
                        }));
                    }
                    workers
                        .into_iter()
                        .map(|worker| worker.join().unwrap())
                        .collect::<Vec<_>>()
                });
                println!(
                    "routing sessions={session_count} threads={threads} round={round} local={local} ns={samples:?}"
                );
            }
        }
    }
}
