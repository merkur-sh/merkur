//! A backed-off path probes on evidence that its peer is reachable, not only
//! when its exponential probe timer next fires.
use super::*;

/// The server queues `bytes` of stream data for the client.
fn server_sends(pair: &mut Pair, server: ConnectionHandle, bytes: usize) {
    let stream = pair.server_streams(server).open(Dir::Uni).unwrap();
    pair.server_send(server, stream)
        .write(&vec![0x5a; bytes])
        .unwrap();
}

/// Lose everything the server sends until its probe timer has backed off
/// `count` times. The client hears nothing and says nothing.
fn lose_server_packets_until_backoff(pair: &mut Pair, server: ConnectionHandle, count: u32) {
    loop {
        pair.drive_server();
        pair.client.inbound.clear();
        if pair.server_conn_mut(server).stats().path.pto_count >= count {
            return;
        }
        let wakeup = pair
            .server
            .next_wakeup()
            .expect("the server waits on its probe timer");
        pair.time = pair.time.max(wakeup);
    }
}

fn sent(pair: &mut Pair, server: ConnectionHandle) -> u64 {
    pair.server_conn_mut(server).stats().udp_tx.datagrams
}

fn pto_count(pair: &mut Pair, server: ConnectionHandle) -> u32 {
    pair.server_conn_mut(server).stats().path.pto_count
}

/// One ack-eliciting packet from the client, delivered to the server at the
/// current instant.
fn client_pings(pair: &mut Pair, client: ConnectionHandle) {
    pair.client_conn_mut(client).ping();
    pair.drive_client();
    pair.drive_server();
}

#[test]
fn a_packet_heard_from_the_peer_probes_a_backed_off_path_at_once() {
    let _guard = subscribe();
    let mut pair = Pair::default();
    let (client, server) = pair.connect();
    server_sends(&mut pair, server, 1000);
    lose_server_packets_until_backoff(&mut pair, server, 3);
    let own_probe = pair.server.next_wakeup().unwrap();

    let before = sent(&mut pair, server);
    client_pings(&mut pair, client);
    assert_eq!(
        sent(&mut pair, server),
        before + 1,
        "the client's packet must draw one probe in the same poll"
    );
    assert!(pair.time < own_probe, "no clock advanced to the backed-off timer");
    assert_eq!(pto_count(&mut pair, server), 3, "only an ACK resets the backoff");

    pair.drive();
    assert_eq!(pto_count(&mut pair, server), 0);
    let path = pair.server_conn_mut(server).stats().path;
    assert_eq!(path.bytes_in_flight, 0, "the whole tail was acknowledged");
}

#[test]
fn every_packet_heard_during_an_outage_draws_exactly_one_probe() {
    let _guard = subscribe();
    let mut pair = Pair::default();
    let (client, server) = pair.connect();
    server_sends(&mut pair, server, 1000);
    lose_server_packets_until_backoff(&mut pair, server, 2);
    for _ in 0..10 {
        let before = sent(&mut pair, server);
        client_pings(&mut pair, client);
        assert_eq!(sent(&mut pair, server), before + 1);
        pair.client.inbound.clear();
    }
    assert_eq!(pto_count(&mut pair, server), 2);
}

#[test]
fn an_asymmetric_outage_resumes_on_the_first_packet_after_it_heals() {
    let _guard = subscribe();
    let mut pair = Pair::default();
    let (client, server) = pair.connect();
    server_sends(&mut pair, server, 4000);
    lose_server_packets_until_backoff(&mut pair, server, 2);
    // The client keeps talking through the outage; each packet draws a probe
    // the outage eats. A rule that re-armed once per backoff step would have
    // spent itself here.
    for _ in 0..20 {
        client_pings(&mut pair, client);
        pair.client.inbound.clear();
    }
    let own_probe = pair.server.next_wakeup().unwrap();

    // Healed. The next client packet draws a probe in the same poll, and the
    // tail is acknowledged long before the backed-off timer would have tried.
    let before = sent(&mut pair, server);
    client_pings(&mut pair, client);
    assert_eq!(sent(&mut pair, server), before + 1);
    while pto_count(&mut pair, server) != 0 {
        assert!(pair.step(), "the connection went idle while backed off");
        assert!(
            pair.time < own_probe,
            "recovery waited for the backed-off probe timer"
        );
    }
    pair.drive();
    assert_eq!(pair.server_conn_mut(server).stats().path.bytes_in_flight, 0);
}

#[test]
fn two_backed_off_endpoints_converge_after_one_probe_exchange() {
    let _guard = subscribe();
    let mut pair = Pair::default();
    let (client, server) = pair.connect();
    let stream = pair.client_streams(client).open(Dir::Uni).unwrap();
    pair.client_send(client, stream)
        .write(&[0xa5; 1000])
        .unwrap();
    // Both directions dark. The client backs off first, so the two probe
    // timers never expire together.
    let dark = |pair: &mut Pair, done: &dyn Fn(u32, u32) -> bool| loop {
        pair.drive_client();
        pair.server.inbound.clear();
        pair.drive_server();
        pair.client.inbound.clear();
        let client_backoff = pair.client_conn_mut(client).stats().path.pto_count;
        if done(client_backoff, pto_count(pair, server)) {
            return;
        }
        let wakeup = min_opt(pair.client.next_wakeup(), pair.server.next_wakeup()).unwrap();
        pair.time = pair.time.max(wakeup);
    };
    dark(&mut pair, &|client, _| client >= 1);
    server_sends(&mut pair, server, 1000);
    dark(&mut pair, &|client, server| client >= 2 && server >= 2);
    let (client_timer, server_timer) = (
        pair.client.next_wakeup().unwrap(),
        pair.server.next_wakeup().unwrap(),
    );
    assert_ne!(client_timer, server_timer);
    let later = client_timer.max(server_timer);
    // Healed: the first expiring timer's probe reaches the other side, whose
    // own probe answers it, so neither waits for its own backed-off timer.
    while pair.client_conn_mut(client).stats().path.pto_count != 0 || pto_count(&mut pair, server) != 0
    {
        assert!(pair.step(), "the connection went idle while backed off");
        assert!(
            pair.time < later,
            "one side waited for its own backed-off probe timer"
        );
    }
}

#[test]
fn probe_now_needs_an_expired_probe_timer_and_data_in_flight() {
    let _guard = subscribe();
    let mut pair = Pair::default();
    let (_, server) = pair.connect();
    let now = pair.time;
    assert!(!pair.server_conn_mut(server).probe_now(now), "idle");
    server_sends(&mut pair, server, 1000);
    pair.drive_server();
    pair.client.inbound.clear();
    assert!(
        !pair.server_conn_mut(server).probe_now(now),
        "in flight, but no probe timeout has expired"
    );
    lose_server_packets_until_backoff(&mut pair, server, 1);
    let now = pair.time;
    assert!(pair.server_conn_mut(server).probe_now(now));
}

#[test]
fn a_packet_one_member_hears_probes_every_backed_off_sibling() {
    let _guard = subscribe();
    let mut heard = Pair::default();
    let (heard_client, heard_server) = heard.connect();
    let mut waiting = Pair::default();
    let (_, waiting_server) = waiting.connect();
    let mut idle = Pair::default();
    let (_, idle_server) = idle.connect();
    let group = ProbeGroup::new();
    for (pair, server) in [
        (&mut heard, heard_server),
        (&mut waiting, waiting_server),
        (&mut idle, idle_server),
    ] {
        pair.server_conn_mut(server)
            .join_probe_group(&group)
            .unwrap();
    }
    server_sends(&mut waiting, waiting_server, 1000);
    lose_server_packets_until_backoff(&mut waiting, waiting_server, 2);
    let own_probe = waiting.server.next_wakeup().unwrap();
    let before = sent(&mut waiting, waiting_server);
    let idle_before = sent(&mut idle, idle_server);
    waiting.drive_server();
    assert_eq!(sent(&mut waiting, waiting_server), before, "nothing heard yet");

    heard.time = heard.time.max(waiting.time);
    client_pings(&mut heard, heard_client);
    waiting.drive_server();
    idle.drive_server();
    assert_eq!(
        sent(&mut waiting, waiting_server),
        before + 1,
        "the backed-off sibling probes in its next poll"
    );
    assert!(waiting.time < own_probe);
    assert_eq!(
        sent(&mut idle, idle_server),
        idle_before,
        "a sibling with nothing to probe is not disturbed"
    );
    waiting.drive();
    assert_eq!(pto_count(&mut waiting, waiting_server), 0);
}

/// A restarted host answers every old connection with a stateless reset. Its
/// siblings learn of the restart from one member's reset, not each from its own
/// next packet. The restarted host keeps its connection ID key either way, so
/// only the reset key decides whether the reset verifies.
fn restart_resets_siblings(same_key: bool) -> (bool, bool) {
    let _guard = subscribe();
    let config = |key: u8| {
        let mut config = EndpointConfig::new(Arc::new(hmac::Key::new(
            hmac::HMAC_SHA256,
            &[key; 32],
        )));
        config.cid_generator(|| Box::new(HashedConnectionIdGenerator::from_key(7)));
        config.min_reset_interval(Duration::ZERO);
        Arc::new(config)
    };
    let mut first = Pair::new(config(1), server_config());
    let (first_client, _) = first.connect();
    let mut second = Pair::new(config(1), server_config());
    let (second_client, _) = second.connect();
    first.drive();
    second.drive();
    let group = ProbeGroup::new();
    first
        .client_conn_mut(first_client)
        .join_probe_group(&group)
        .unwrap();
    second
        .client_conn_mut(second_client)
        .join_probe_group(&group)
        .unwrap();
    let restarted = config(if same_key { 1 } else { 2 });
    first.restart_server(restarted.clone());
    second.restart_server(restarted);
    let second_start = second.time;

    // The first member's next packet meets the restarted host.
    first.client_conn_mut(first_client).ping();
    first.drive_client();
    first.drive_server();
    first.drive_client();
    // Its sibling sends at once, and meets the same host.
    second.drive_client();
    second.drive_server();
    second.drive_client();
    assert_eq!(second.time, second_start, "no clock advanced");
    let reset = |pair: &mut Pair, client| {
        matches!(
            pair.client_conn_mut(client).poll(),
            Some(Event::ConnectionLost {
                reason: ConnectionError::Reset
            })
        )
    };
    (
        reset(&mut first, first_client),
        reset(&mut second, second_client),
    )
}

#[test]
fn a_verified_reset_makes_every_sibling_verify_its_own_state() {
    assert_eq!(restart_resets_siblings(true), (true, true));
}

#[test]
fn a_reset_under_another_key_verifies_nothing_and_resets_nobody() {
    assert_eq!(restart_resets_siblings(false), (false, false));
}

#[test]
fn only_probes_may_leave_after_an_expired_probe_timer_with_a_full_window() {
    let _guard = subscribe();
    let mut pair = Pair::default();
    let (_, server) = pair.connect();
    assert!(!pair.server_conn_mut(server).is_send_blocked());
    let window = pair.server_conn_mut(server).congestion_window() as usize;
    server_sends(&mut pair, server, 4 * window);
    pair.drive_server();
    pair.client.inbound.clear();
    let path = pair.server_conn_mut(server).stats().path;
    assert!(
        path.cwnd.saturating_sub(path.bytes_in_flight) < u64::from(path.current_mtu),
        "the window admits no full-size packet: {} in flight, window {}",
        path.bytes_in_flight,
        path.cwnd
    );
    assert!(
        !pair.server_conn_mut(server).is_send_blocked(),
        "a full window alone is ordinary congestion"
    );
    lose_server_packets_until_backoff(&mut pair, server, 1);
    assert!(pair.server_conn_mut(server).is_send_blocked());
    assert!(pair.server_conn_mut(server).stats().path.send_blocked);
    // The probe's acknowledgment reopens the path.
    pair.drive();
    assert!(!pair.server_conn_mut(server).is_send_blocked());
}

#[test]
fn an_expired_probe_timer_with_window_room_is_not_blocked() {
    let _guard = subscribe();
    let mut pair = Pair::default();
    let (_, server) = pair.connect();
    server_sends(&mut pair, server, 1000);
    lose_server_packets_until_backoff(&mut pair, server, 2);
    assert!(!pair.server_conn_mut(server).is_send_blocked());
}

#[test]
fn clearing_queued_datagrams_drops_only_unsent_ones_and_unblocks_a_waiting_sender() {
    let _guard = subscribe();
    let mut pair = Pair::default();
    let (client, server) = pair.connect();
    pair.client_datagrams(client)
        .send(Bytes::from_static(b"sent"), false)
        .unwrap();
    pair.drive();
    assert_eq!(pair.server_datagrams(server).recv().unwrap(), &b"sent"[..]);

    let space = pair.client_datagrams(client).send_buffer_space();
    let size = pair.client_datagrams(client).max_size().unwrap();
    let mut queued = 0;
    while pair
        .client_datagrams(client)
        .send(vec![7; size.min(space)].into(), false)
        .is_ok()
    {
        queued += 1;
    }
    assert!(queued > 0);
    assert_eq!(pair.client_datagrams(client).clear_queued(), queued);
    assert_matches!(
        pair.client_conn_mut(client).poll(),
        Some(Event::DatagramsUnblocked)
    );
    assert_eq!(pair.client_datagrams(client).clear_queued(), 0);
    pair.drive();
    assert!(pair.server_datagrams(server).recv().is_none());
}
