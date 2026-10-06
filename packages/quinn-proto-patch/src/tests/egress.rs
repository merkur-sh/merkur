//! Actual packetization/recovery tests for the optional data egress group.
use super::*;

fn pair() -> (Pair, ConnectionHandle, ConnectionHandle) {
    pair_with_latency(Duration::ZERO)
}

fn pair_with_latency(latency: Duration) -> (Pair, ConnectionHandle, ConnectionHandle) {
    let mut pair = Pair::default();
    pair.latency = latency;
    let mut config = client_config();
    let mut transport = TransportConfig::default();
    transport.mtu_discovery_config(None);
    config.transport_config(Arc::new(transport));
    let (client, server) = pair.connect_with(config);
    (pair, client, server)
}

#[test]
fn shared_egress_prioritizes_actual_input_and_never_exceeds_aggregate_credit() {
    let (mut high, hc, hs) = pair();
    let (mut low, lc, _) = pair();
    let now = high.time.max(low.time);
    let group = high.client_conn_mut(hc).start_egress_group(now).unwrap();
    low.client_conn_mut(lc)
        .join_egress_group(&group, EgressClass::Bulk)
        .unwrap();
    let stream = low.client_streams(lc).open(Dir::Uni).unwrap();
    low.client_send(lc, stream)
        .set_priority(EGRESS_IMAGE_PRIORITY)
        .unwrap();
    low.client_send(lc, stream)
        .write(&vec![0x57; 65536])
        .unwrap();
    low.client_send(lc, stream).finish().unwrap();
    high.client_datagrams(hc)
        .send(Bytes::from_static(b"input"), false)
        .unwrap();
    high.client_conn_mut(hc).wake_egress();
    let mut out = Vec::new();
    assert!(
        low.client_conn_mut(lc)
            .poll_transmit(now, 10, &mut out)
            .is_none()
    );
    high.time = now;
    high.drive_client();
    high.drive_server();
    assert_eq!(high.server_datagrams(hs).recv().unwrap(), &b"input"[..]);
    for tick in 1..500 {
        let now = now + Duration::from_millis(tick);
        high.time = now;
        low.time = now;
        high.drive_client();
        high.drive_server();
        low.drive_client();
        low.drive_server();
        let stats = group.stats();
        assert_eq!(stats.reserved_bytes, 0);
        assert_eq!(
            stats.bytes_in_flight,
            high.client_conn_mut(hc).bytes_in_flight() + low.client_conn_mut(lc).bytes_in_flight()
        );
        assert!(stats.bytes_in_flight <= stats.congestion_window);
    }
    assert_eq!(group.stats().bytes_in_flight, 0);
}

#[test]
fn interactive_leaves_in_the_next_transmit_while_bulk_holds_the_window() {
    let (mut high, hc, _) = pair();
    let (mut low, lc, _) = pair();
    let now = high.time.max(low.time);
    high.time = now;
    low.time = now;
    let group = high.client_conn_mut(hc).start_egress_group(now).unwrap();
    low.client_conn_mut(lc)
        .join_egress_group(&group, EgressClass::Bulk)
        .unwrap();
    let image = low.client_streams(lc).open(Dir::Uni).unwrap();
    low.client_send(lc, image)
        .set_priority(EGRESS_IMAGE_PRIORITY)
        .unwrap();
    low.client_send(lc, image)
        .write(&vec![0x57; 1 << 20])
        .unwrap();
    let mut out = Vec::new();
    while low
        .client_conn_mut(lc)
        .poll_transmit(now, 1, &mut out)
        .is_some()
    {
        out.clear();
    }
    let stats = group.stats();
    assert_eq!(
        stats.bytes_in_flight + stats.interactive_reserve,
        stats.congestion_window,
        "bulk holds everything but one interactive packet"
    );
    // The ACK datagram spends that packet and stays unacknowledged.
    high.client_datagrams(hc)
        .send(Bytes::from_static(b"ack"), false)
        .unwrap();
    high.client_conn_mut(hc).wake_egress();
    assert!(
        high.client_conn_mut(hc)
            .poll_transmit(now, 1, &mut out)
            .is_some()
    );
    out.clear();
    // The echo datagram, the ACK's reliable twin and a PING all leave in the
    // next transmit: no acknowledgment is delivered and no timer fires.
    let before = high.client_conn_mut(hc).stats().frame_tx;
    high.client_datagrams(hc)
        .send(Bytes::from_static(b"echo"), false)
        .unwrap();
    let twin = high.client_streams(hc).open(Dir::Uni).unwrap();
    high.client_send(hc, twin).write(b"twin").unwrap();
    high.client_conn_mut(hc).ping();
    high.client_conn_mut(hc).wake_egress();
    assert!(
        high.client_conn_mut(hc)
            .poll_transmit(now, 1, &mut out)
            .is_some()
    );
    let after = high.client_conn_mut(hc).stats().frame_tx;
    assert_eq!(after.datagram, before.datagram + 1);
    assert_eq!(after.stream, before.stream + 1);
    assert_eq!(after.ping, before.ping + 1);
    assert_eq!(group.stats().interactive.blocked, 0);
}

#[test]
fn queued_interactive_work_keeps_priority_while_its_own_packets_wait() {
    let (mut high, hc, _) = pair_with_latency(Duration::from_millis(10));
    let (mut low, lc, ls) = pair_with_latency(Duration::from_millis(10));
    let start = high.time.max(low.time);
    high.time = start;
    low.time = start;
    let group = high.client_conn_mut(hc).start_egress_group(start).unwrap();
    low.client_conn_mut(lc)
        .join_egress_group(&group, EgressClass::Bulk)
        .unwrap();
    // Grow the shared window past interactive's own with acknowledged bulk.
    let image = low.client_streams(lc).open(Dir::Uni).unwrap();
    low.client_send(lc, image)
        .set_priority(EGRESS_IMAGE_PRIORITY)
        .unwrap();
    // Flow control admits partial writes: keep producing until the whole
    // transfer, rather than only its first model-sized window, is acknowledged.
    let body = vec![0x57; 256 * 1024];
    let mut written = 0;
    let mut now = start;
    for _ in 0..1000 {
        if written < body.len() {
            match low.client_send(lc, image).write(&body[written..]) {
                Ok(n) => written += n,
                Err(WriteError::Blocked) => {}
                Err(error) => panic!("image write failed: {error}"),
            }
        }
        now += Duration::from_millis(1);
        low.time = now;
        low.drive_client();
        low.drive_server();
    }
    assert_eq!(written, body.len());
    assert_eq!(group.stats().bytes_in_flight, 0);
    let own_window = high.client_conn_mut(hc).congestion_window();
    assert!(group.stats().congestion_window > 4 * own_window);
    // Interactive fills its own congestion window and still has work queued.
    high.time = now;
    let control = high.client_streams(hc).open(Dir::Uni).unwrap();
    high.client_send(hc, control)
        .write(&vec![0x61; 64 * 1024])
        .unwrap();
    high.client_conn_mut(hc).wake_egress();
    let mut out = Vec::new();
    while high
        .client_conn_mut(hc)
        .poll_transmit(now, 1, &mut out)
        .is_some()
    {
        out.clear();
    }
    let stats = group.stats();
    assert!(
        stats.congestion_window > stats.bytes_in_flight + 4 * stats.interactive_reserve,
        "the shared window has room for bulk"
    );
    // Bulk may not take that room while interactive work waits for its own
    // acknowledgments: priority is released only when the queue drains.
    let next = low.client_streams(lc).open(Dir::Uni).unwrap();
    low.client_send(lc, next)
        .set_priority(EGRESS_IMAGE_PRIORITY)
        .unwrap();
    low.client_send(lc, next).write(&[0x62; 4096]).unwrap();
    let before = low.client_conn_mut(lc).stats().frame_tx.stream;
    while low
        .client_conn_mut(lc)
        .poll_transmit(now, 1, &mut out)
        .is_some()
    {
        out.clear();
    }
    assert_eq!(low.client_conn_mut(lc).stats().frame_tx.stream, before);
    assert!(group.stats().bulk.blocked > 0);
    let _ = ls;
}

#[test]
fn shared_egress_counts_existing_flight_and_close_retires_exactly_once() {
    let (mut pair, client, _) = pair();
    pair.client_datagrams(client)
        .send(Bytes::from_static(b"already sent"), false)
        .unwrap();
    pair.drive_client();
    let debt = pair.client_conn_mut(client).bytes_in_flight();
    assert!(debt > 0);
    let now = pair.time;
    let group = pair
        .client_conn_mut(client)
        .start_egress_group(now)
        .unwrap();
    assert_eq!(group.stats().bytes_in_flight, debt);
    pair.client_conn_mut(client)
        .close(now, VarInt::from_u32(0), Bytes::new());
    assert_eq!(group.stats().bytes_in_flight, 0);
    pair.drive();
    assert_eq!(group.stats().bytes_in_flight, 0);
}

#[test]
fn direct_images_leave_a_packet_for_input_on_the_same_connection() {
    let (mut pair, client, _) = pair();
    let now = pair.time;
    let group = pair
        .client_conn_mut(client)
        .start_egress_group(now)
        .unwrap();
    let stream = pair.client_streams(client).open(Dir::Uni).unwrap();
    pair.client_send(client, stream)
        .set_priority(EGRESS_IMAGE_PRIORITY)
        .unwrap();
    pair.client_send(client, stream)
        .write(&vec![0x61; 65536])
        .unwrap();
    let mut out = Vec::new();
    assert!(
        pair.client_conn_mut(client)
            .poll_transmit(now, 64, &mut out)
            .is_some()
    );
    let stats = group.stats();
    assert!(stats.bytes_in_flight + stats.interactive_reserve <= stats.congestion_window);
    pair.client_datagrams(client)
        .send(Bytes::from_static(b"urgent"), false)
        .unwrap();
    out.clear();
    assert!(
        pair.client_conn_mut(client)
            .poll_transmit(now, 1, &mut out)
            .is_some()
    );
    assert!(group.stats().bytes_in_flight <= group.stats().congestion_window);
}

#[test]
fn direct_image_flight_never_holds_the_same_connections_input() {
    // Direct transport: one connection, one interactive member, both classes.
    let (mut pair, client, _) = pair();
    let now = pair.time;
    let group = pair
        .client_conn_mut(client)
        .start_egress_group(now)
        .unwrap();
    let image = pair.client_streams(client).open(Dir::Uni).unwrap();
    pair.client_send(client, image)
        .set_priority(EGRESS_IMAGE_PRIORITY)
        .unwrap();
    pair.client_send(client, image)
        .write(&vec![0x57; 1 << 20])
        .unwrap();
    let mut out = Vec::new();
    while pair
        .client_conn_mut(client)
        .poll_transmit(now, 1, &mut out)
        .is_some()
    {
        out.clear();
    }
    let stats = group.stats();
    assert_eq!(
        stats.bytes_in_flight + stats.interactive_reserve,
        stats.congestion_window,
        "images hold everything but one interactive packet"
    );
    // The ACK datagram spends that packet and stays unacknowledged.
    pair.client_datagrams(client)
        .send(Bytes::from_static(b"ack"), false)
        .unwrap();
    pair.client_conn_mut(client).wake_egress();
    assert!(
        pair.client_conn_mut(client)
            .poll_transmit(now, 1, &mut out)
            .is_some()
    );
    out.clear();
    // The echo, a PING and a control record four packets long all leave at
    // once: the connection's own image flight and the pacing tokens images
    // spent are bulk's, so neither this connection's window and pacer nor the
    // group holds its input back.
    let before = pair.client_conn_mut(client).stats().frame_tx;
    pair.client_datagrams(client)
        .send(Bytes::from_static(b"echo"), false)
        .unwrap();
    let control = pair.client_streams(client).open(Dir::Uni).unwrap();
    pair.client_send(client, control)
        .write(&[0x61; 4096])
        .unwrap();
    pair.client_conn_mut(client).ping();
    pair.client_conn_mut(client).wake_egress();
    while pair
        .client_conn_mut(client)
        .poll_transmit(now, 1, &mut out)
        .is_some()
    {
        out.clear();
    }
    let after = pair.client_conn_mut(client).stats().frame_tx;
    assert_eq!(after.datagram, before.datagram + 1);
    assert_eq!(after.ping, before.ping + 1);
    assert!(
        after.stream >= before.stream + 4,
        "the whole control record left: {} stream frames",
        after.stream - before.stream
    );
    assert_eq!(group.stats().interactive.blocked, 0);
    // Every packet retires from the ledger it was charged to.
    pair.drive();
    assert_eq!(group.stats().bytes_in_flight, 0);
}

#[test]
fn direct_images_never_spend_the_pacer_input_waits_on() {
    let (mut pair, client, _) = pair_with_latency(Duration::from_millis(10));
    let start = pair.time;
    let group = pair
        .client_conn_mut(client)
        .start_egress_group(start)
        .unwrap();
    let image = pair.client_streams(client).open(Dir::Uni).unwrap();
    pair.client_send(client, image)
        .set_priority(EGRESS_IMAGE_PRIORITY)
        .unwrap();
    // Grow the window with acknowledged images, so below the pacer, not the
    // window, is what stops them.
    let body = vec![0x57; 512 * 1024];
    let mut written = 0;
    for _ in 0..1000 {
        if written < body.len() {
            match pair.client_send(client, image).write(&body[written..]) {
                Ok(n) => written += n,
                Err(WriteError::Blocked) => {}
                Err(error) => panic!("image write failed: {error}"),
            }
        }
        pair.time += Duration::from_millis(1);
        pair.drive_client();
        pair.drive_server();
    }
    assert_eq!(written, body.len());
    assert_eq!(group.stats().bytes_in_flight, 0);
    let now = pair.time;
    pair.client_send(client, image)
        .write(&vec![0x57; 1 << 20])
        .unwrap();
    let mut out = Vec::new();
    while pair
        .client_conn_mut(client)
        .poll_transmit(now, 1, &mut out)
        .is_some()
    {
        out.clear();
    }
    let stats = group.stats();
    assert!(stats.bulk.paced > 0, "the group's pacer stopped the images");
    let connection = pair.client_conn_mut(client);
    let deadline = connection
        .poll_timeout()
        .expect("paced images have a deadline");
    assert!(connection.is_egress_pacing_deadline(deadline));
    assert!(
        stats.bytes_in_flight + 8 * stats.interactive_reserve < stats.congestion_window,
        "the window did not"
    );
    // Images spent the group's tokens, not the connection's: the echo, a PING
    // and a control record four packets long leave at once, unpaced by them.
    let before = pair.client_conn_mut(client).stats().frame_tx;
    pair.client_datagrams(client)
        .send(Bytes::from_static(b"echo"), false)
        .unwrap();
    let control = pair.client_streams(client).open(Dir::Uni).unwrap();
    pair.client_send(client, control)
        .write(&[0x61; 4096])
        .unwrap();
    pair.client_conn_mut(client).ping();
    pair.client_conn_mut(client).wake_egress();
    while pair
        .client_conn_mut(client)
        .poll_transmit(now, 1, &mut out)
        .is_some()
    {
        out.clear();
    }
    let after = pair.client_conn_mut(client).stats().frame_tx;
    assert_eq!(after.datagram, before.datagram + 1);
    assert_eq!(after.ping, before.ping + 1);
    assert!(
        after.stream >= before.stream + 4,
        "the whole control record left: {} stream frames",
        after.stream - before.stream
    );
}

#[test]
fn closed_and_wrong_class_attachments_cannot_reacquire_credit() {
    let (mut interactive, ic, _) = pair();
    let (mut bulk, bc, _) = pair();
    let now = interactive.time.max(bulk.time);
    let group = interactive
        .client_conn_mut(ic)
        .start_egress_group(now)
        .unwrap();
    bulk.client_conn_mut(bc)
        .join_egress_group(&group, EgressClass::Bulk)
        .unwrap();
    assert_eq!(
        bulk.client_conn_mut(bc)
            .start_egress_group(now)
            .unwrap_err(),
        EgressError::Occupied
    );
    bulk.client_conn_mut(bc)
        .close(now, VarInt::from_u32(0), Bytes::new());
    assert_eq!(
        bulk.client_conn_mut(bc)
            .join_egress_group(&group, EgressClass::Bulk),
        Err(EgressError::Closed)
    );
    assert_eq!(
        bulk.client_conn_mut(bc)
            .start_egress_group(now)
            .unwrap_err(),
        EgressError::Closed
    );
    let (mut replacement, rc, _) = pair();
    replacement
        .client_conn_mut(rc)
        .join_egress_group(&group, EgressClass::Bulk)
        .unwrap();
}

#[test]
fn blocked_bulk_still_acknowledges_without_sending_queued_control_or_images() {
    let (mut high, hc, _) = pair();
    let (mut low, lc, ls) = pair();
    let now = high.time.max(low.time);
    high.time = now;
    low.time = now;
    let group = high.client_conn_mut(hc).start_egress_group(now).unwrap();
    low.client_conn_mut(lc)
        .join_egress_group(&group, EgressClass::Bulk)
        .unwrap();
    // Keep the interactive member ready without driving it; bulk has no admission.
    high.client_datagrams(hc)
        .send(Bytes::from_static(b"urgent"), false)
        .unwrap();
    high.client_conn_mut(hc).wake_egress();
    let image = low.client_streams(lc).open(Dir::Uni).unwrap();
    low.client_send(lc, image)
        .set_priority(EGRESS_IMAGE_PRIORITY)
        .unwrap();
    low.client_send(lc, image).write(b"image").unwrap();
    low.client_conn_mut(lc).ping();
    let before = low.client_conn_mut(lc).stats().frame_tx;
    low.server_datagrams(ls)
        .send(Bytes::from_static(b"reverse"), false)
        .unwrap();
    low.drive_server();
    low.drive_client();
    low.time += Duration::from_millis(30);
    low.drive_client();
    let after = low.client_conn_mut(lc).stats().frame_tx;
    assert!(after.acks > before.acks);
    assert_eq!(after.ping, before.ping);
    assert_eq!(after.stream, before.stream);
}

#[test]
fn bulk_probe_loss_and_reordered_packets_retire_shared_debt_without_blocking_input() {
    let (mut high, hc, hs) = pair();
    let (mut low, lc, ls) = pair();
    let start = high.time.max(low.time);
    high.time = start;
    low.time = start;
    let group = high.client_conn_mut(hc).start_egress_group(start).unwrap();
    low.client_conn_mut(lc)
        .join_egress_group(&group, EgressClass::Bulk)
        .unwrap();
    let stream = low.client_streams(lc).open(Dir::Uni).unwrap();
    low.client_send(lc, stream)
        .set_priority(EGRESS_IMAGE_PRIORITY)
        .unwrap();
    let pixels = vec![0x57; 65536];
    low.client_send(lc, stream).write(&pixels).unwrap();
    low.client_send(lc, stream).finish().unwrap();
    // Lose the entire first flight. A real PTO, not a synthetic accounting
    // callback, must break the deadlock and its probes must remain charged.
    low.drive_client();
    assert!(!low.server.inbound.is_empty());
    low.server.inbound.clear();
    let mut probes = 0;
    let mut inputs = 0;
    for tick in 1..2000 {
        let now = start + Duration::from_millis(tick);
        high.time = now;
        low.time = now;
        if tick % 100 == 1 {
            high.client_datagrams(hc)
                .send(Bytes::from_static(b"input"), false)
                .unwrap();
            high.client_conn_mut(hc).wake_egress();
            inputs += 1;
        }
        high.drive_client();
        high.drive_server();
        if tick % 100 == 1 {
            assert_eq!(high.server_datagrams(hs).recv().unwrap(), &b"input"[..]);
        }
        low.drive_client();
        probes = probes.max(low.client_conn_mut(lc).stats().path.pto_count);
        low.server.inbound.make_contiguous().reverse();
        low.drive_server();
        let stats = group.stats();
        assert_eq!(stats.reserved_bytes, 0);
        assert_eq!(
            stats.bytes_in_flight,
            high.client_conn_mut(hc).bytes_in_flight() + low.client_conn_mut(lc).bytes_in_flight()
        );
    }
    assert_eq!(inputs, 20);
    assert!(probes > 0);
    assert!(low.client_conn_mut(lc).stats().path.lost_packets > 0);
    assert_eq!(group.stats().bytes_in_flight, 0);
    assert_eq!(low.server_streams(ls).accept(Dir::Uni), Some(stream));
    let mut recv = low.server_recv(ls, stream);
    let mut chunks = recv.read(true).unwrap();
    let mut received = Vec::new();
    while let Some(chunk) = chunks.next(usize::MAX).unwrap() {
        assert_eq!(chunk.offset, received.len() as u64);
        received.extend_from_slice(&chunk.bytes);
    }
    let _ = chunks.finalize();
    assert_eq!(received, pixels);
}

#[test]
fn real_path_migration_preserves_shared_flight_and_releases_every_packet() {
    let (mut pair, client, server) = pair();
    let now = pair.time;
    let group = pair
        .server_conn_mut(server)
        .start_egress_group(now)
        .unwrap();
    pair.server_datagrams(server)
        .send(Bytes::from_static(b"old-path"), false)
        .unwrap();
    pair.drive_server();
    assert!(group.stats().bytes_in_flight > 0);
    // Preserve unacknowledged old-path packets while the peer proves its new
    // address; a path reset must neither erase nor double-charge their debt.
    pair.client.inbound.clear();
    pair.client.addr = SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        CLIENT_PORTS.lock().unwrap().next().unwrap(),
    );
    pair.client_conn_mut(client).ping();
    for _ in 0..100 {
        let active = pair.step();
        assert_eq!(
            group.stats().bytes_in_flight,
            pair.server_conn_mut(server).outstanding_packet_bytes()
        );
        assert_eq!(group.stats().reserved_bytes, 0);
        if !active {
            break;
        }
    }
    assert_eq!(
        pair.server_conn_mut(server).remote_address(),
        pair.client.addr
    );
    assert_eq!(group.stats().bytes_in_flight, 0);
    pair.server_datagrams(server)
        .send(Bytes::from_static(b"new-path"), false)
        .unwrap();
    pair.drive();
    assert_eq!(
        pair.client_datagrams(client).recv().unwrap(),
        &b"new-path"[..]
    );
    assert_eq!(group.stats().bytes_in_flight, 0);
}

#[test]
fn delivery_samples_allocate_only_for_groups_and_reuse_retired_slots() {
    let (mut pair, client, _) = pair();
    for _ in 0..10 {
        pair.client_datagrams(client)
            .send(Bytes::from_static(b"text"), false)
            .unwrap();
        pair.drive();
    }
    assert_eq!(pair.client_conn_mut(client).egress_sample_storage(), (0, 0));
    let now = pair.time;
    pair.client_conn_mut(client)
        .start_egress_group(now)
        .unwrap();
    pair.client_datagrams(client)
        .send(Bytes::from_static(b"sample"), false)
        .unwrap();
    pair.drive_client();
    let (live, capacity) = pair.client_conn_mut(client).egress_sample_storage();
    assert!(live > 0);
    assert!(capacity >= live);
    pair.drive();
    assert_eq!(pair.client_conn_mut(client).egress_sample_storage().0, 0);
    for _ in 0..10 {
        pair.client_datagrams(client)
            .send(Bytes::from_static(b"reuse"), false)
            .unwrap();
        pair.drive();
        assert_eq!(
            pair.client_conn_mut(client).egress_sample_storage(),
            (0, capacity)
        );
    }
}

/// The real packet builder, recovery, stream credit and model share a shaped
/// virtual link. A clean model must not hide collapse caused by random loss.
#[test]
fn sustained_images_use_the_clean_link() {
    sustained_images_use_the_link(0, 11, false, false, 640_000, Propagation::Fixed);
}
#[test]
fn sustained_images_use_the_link_under_random_loss() {
    for seed in [11, 29, 47, 83, 101] {
        sustained_images_use_the_link(3, seed, false, false, 640_000, Propagation::Fixed);
    }
}
#[test]
fn sustained_images_keep_input_out_of_the_bottleneck_queue() {
    for loss in [0, 3] {
        sustained_images_use_the_link(loss, 11, true, false, 640_000, Propagation::Fixed);
    }
}
#[test]
fn sustained_images_follow_a_slower_bottleneck() {
    sustained_images_use_the_link(0, 11, true, true, 640_000, Propagation::Fixed);
}
#[test]
fn sustained_images_tolerate_a_shallow_buffer() {
    sustained_images_use_the_link(0, 11, false, false, 16_000, Propagation::Fixed);
}
#[test]
fn sustained_images_preserve_capacity_with_propagation_jitter() {
    for seed in [11, 29, 47, 83, 101] {
        sustained_images_use_the_link(0, seed, true, false, 640_000, Propagation::JitterAfterLink);
    }
}

#[test]
fn sustained_images_preserve_capacity_when_jitter_precedes_the_bottleneck() {
    for seed in [11, 29, 47, 83, 101] {
        sustained_images_use_the_link(0, seed, true, false, 640_000, Propagation::JitterBeforeLink);
    }
}

#[derive(Clone, Copy)]
enum Propagation {
    Fixed,
    JitterAfterLink,
    JitterBeforeLink,
}

fn sustained_images_use_the_link(
    loss: u64,
    seed: u64,
    typing: bool,
    rate_drop: bool,
    buffer_bytes: u64,
    propagation: Propagation,
) {
    let jitter = !matches!(propagation, Propagation::Fixed);
    {
        let (mut pair, client, server) =
            deterministic_link_pair_at(Duration::from_millis(if jitter { 30 } else { 60 }));
        let link = util::Link::new(25_000_000, buffer_bytes)
            .with_loss(loss, seed)
            .shared();
        pair.links[0] = Some(link.clone());
        pair.propagation_before_link[0] = matches!(propagation, Propagation::JitterBeforeLink);
        let start = pair.time;
        let group = pair
            .client_conn_mut(client)
            .start_egress_group_seeded(start, seed)
            .unwrap();
        let stream = pair.client_streams(client).open(Dir::Uni).unwrap();
        pair.client_send(client, stream)
            .set_priority(EGRESS_IMAGE_PRIORITY)
            .unwrap();
        let body = vec![0x61; 32 * 1024 * 1024];
        let mut written = 0;
        let mut received = 0;
        let mut warm_received = 0;
        let mut accepted = false;
        let mut input_delays = Vec::new();
        for tick in 1..=if jitter { 60_000u64 } else { 8_000u64 } {
            if jitter {
                // One edge-to-browser hop varies by ±3.75 ms per direction.
                // Keep handshake and transfer RTTs equal so the initial model
                // cannot hide a regression behind an obsolete, higher baseline.
                pair.latency = Duration::from_micros(26_250 + (tick * 7_919 + seed) % 7_501);
            }
            if rate_drop && tick == 4_000 {
                link.borrow_mut().set_rate(10_000_000);
            }
            if typing && tick >= 2_000 && tick % 20 == 0 {
                let sent = tick - 1;
                pair.client_datagrams(client)
                    .send(Bytes::copy_from_slice(&sent.to_le_bytes()), false)
                    .unwrap();
                pair.client_conn_mut(client).wake_egress();
            }
            {
                match pair
                    .client_send(client, stream)
                    .write(&body[written % body.len()..])
                {
                    Ok(n) => written += n,
                    Err(WriteError::Blocked) => {}
                    Err(error) => panic!("image write failed: {error}"),
                }
            }
            let until = start + Duration::from_millis(tick);
            util::drive_pairs_until(&mut [&mut pair], until);
            while let Some(input) = pair.server_datagrams(server).recv() {
                let sent = u64::from_le_bytes(input[..].try_into().unwrap());
                if !rate_drop || sent >= 5_000 {
                    input_delays.push(
                        (pair.time - start - Duration::from_millis(sent))
                            .saturating_sub(Duration::from_millis(60)),
                    );
                }
            }
            if !accepted {
                accepted = pair.server_streams(server).accept(Dir::Uni).is_some();
            }
            if accepted {
                let mut recv = pair.server_recv(server, stream);
                let mut chunks = recv.read(true).unwrap();
                loop {
                    match chunks.next(usize::MAX) {
                        Ok(Some(chunk)) => {
                            assert_eq!(chunk.offset, received as u64);
                            received += chunk.bytes.len();
                        }
                        Err(ReadError::Blocked) => break,
                        result => panic!("unexpected image read: {result:?}"),
                    }
                }
                let _ = chunks.finalize();
            }
            if tick == if rate_drop { 5_000 } else { 2_000 } {
                warm_received = received;
            }
        }
        let goodput = (received - warm_received) as u64
            / if rate_drop {
                3
            } else if jitter {
                58
            } else {
                6
            };
        let minimum = link.borrow().rate_bps() / 8 * (100 - loss) * 80 / 10_000;
        if typing {
            input_delays.sort_unstable();
            assert!(input_delays.len() >= if rate_drop { 130 } else { 270 });
            let p95 = if jitter {
                // The propagation delay varies independently of queueing. Read
                // actual link residence instead of subtracting a fixed RTT.
                let mut residence: Vec<_> = link
                    .borrow()
                    .log
                    .iter()
                    .filter(|packet| packet.arrival >= start + Duration::from_secs(2))
                    .map(|packet| packet.residence)
                    .collect();
                residence.sort_unstable();
                residence[residence.len() * 95 / 100]
            } else {
                input_delays[input_delays.len() * 95 / 100]
            };
            // Jitter before the bottleneck compresses even perfectly paced
            // traffic into arrival trains. Its full 7.5 ms span can become FIFO
            // residence; that is separate from the controller's 3 ms allowance.
            // Jitter after the bottleneck cannot create that queue.
            let budget = Duration::from_millis(3)
                + if matches!(propagation, Propagation::JitterBeforeLink) {
                    Duration::from_micros(7_500)
                } else {
                    Duration::ZERO
                };
            assert!(
                p95 <= budget,
                "loss={loss} rate_drop={rate_drop} link queue p95={p95:?}; goodput={goodput}/{minimum} B/s; model={:?}",
                group.stats()
            );
        }
        assert!(
            goodput >= minimum,
            "seed={seed} {loss}% loss: {goodput} B/s below {minimum}; model={:?}; wire bytes={} drops={}",
            group.stats(),
            link.borrow().departed_bytes,
            link.borrow().lost_after_link
        );
    }
}

fn deterministic_link_pair() -> (Pair, ConnectionHandle, ConnectionHandle) {
    deterministic_link_pair_at(Duration::from_millis(60))
}

fn deterministic_link_pair_at(latency: Duration) -> (Pair, ConnectionHandle, ConnectionHandle) {
    let mut pair = Pair::default_with_deterministic_pns();
    pair.latency = latency;
    let mut config = client_config();
    let mut transport = TransportConfig::default();
    transport.mtu_discovery_config(None);
    transport.deterministic_packet_numbers(true);
    config.transport_config(Arc::new(transport));
    let (client, server) = pair.connect_with(config);
    (pair, client, server)
}

#[test]
fn sustained_images_share_a_bottleneck_with_cubic() {
    let mut flows = [deterministic_link_pair(), deterministic_link_pair()];
    let start = flows.iter().map(|(pair, _, _)| pair.time).max().unwrap();
    let link = util::Link::new(25_000_000, 640_000).shared();
    let mut streams = Vec::new();
    for (index, (pair, client, _)) in flows.iter_mut().enumerate() {
        pair.time = start;
        pair.links[0] = Some(link.clone());
        pair.link_source = index as u8;
        if index == 0 {
            pair.client_conn_mut(*client)
                .start_egress_group_seeded(start, 11)
                .unwrap();
        }
        let stream = pair.client_streams(*client).open(Dir::Uni).unwrap();
        if index == 0 {
            pair.client_send(*client, stream)
                .set_priority(EGRESS_IMAGE_PRIORITY)
                .unwrap();
        }
        streams.push(stream);
    }
    let body = vec![0x61; 32 * 1024 * 1024];
    let mut written = [0; 2];
    let mut received = [0; 2];
    let mut warm_received = [0; 2];
    let mut accepted = [false; 2];
    // Keep both senders saturated across multiple bandwidth/RTT probes. The
    // competition experiment specifies sixty seconds, not its first probe.
    for tick in 1..=60_000 {
        for (index, (pair, client, _)) in flows.iter_mut().enumerate() {
            match pair
                .client_send(*client, streams[index])
                .write(&body[written[index] % body.len()..])
            {
                Ok(n) => written[index] += n,
                Err(WriteError::Blocked) => {}
                Err(error) => panic!("write failed: {error}"),
            }
        }
        let [first, second] = &mut flows;
        util::drive_pairs_until(
            &mut [&mut first.0, &mut second.0],
            start + Duration::from_millis(tick),
        );
        for (index, (pair, _, server)) in flows.iter_mut().enumerate() {
            if !accepted[index] {
                accepted[index] = pair.server_streams(*server).accept(Dir::Uni).is_some();
            }
            if !accepted[index] {
                continue;
            }
            let mut recv = pair.server_recv(*server, streams[index]);
            let mut chunks = recv.read(true).unwrap();
            loop {
                match chunks.next(usize::MAX) {
                    Ok(Some(chunk)) => {
                        assert_eq!(chunk.offset, received[index] as u64);
                        received[index] += chunk.bytes.len();
                    }
                    Err(ReadError::Blocked) => break,
                    result => panic!("unexpected read: {result:?}"),
                }
            }
            let _ = chunks.finalize();
        }
        if tick == 2_000 {
            warm_received = received;
        }
    }
    let goodput = [0, 1].map(|index| (received[index] - warm_received[index]) as u64 / 58);
    // Neither flow may starve the other. Both use the same RTT and FIFO.
    let minimum = 25_000_000 / 8 / 5;
    assert!(
        goodput.iter().all(|&rate| rate >= minimum),
        "image/CUBIC goodput: {goodput:?}"
    );
}

#[test]
fn shared_carriers_preserve_capacity_with_propagation_jitter() {
    shared_carriers_with_jitter(false, 20);
}

#[test]
fn infrequent_input_does_not_wait_behind_bandwidth_probes() {
    shared_carriers_with_jitter(false, 1_000);
}

#[test]
fn infrequent_input_with_jitter_before_the_bottleneck() {
    shared_carriers_with_jitter(true, 1_000);
}

fn shared_carriers_with_jitter(before_link: bool, input_period: u64) {
    let mut flows = [
        deterministic_link_pair_at(Duration::from_millis(30)),
        deterministic_link_pair_at(Duration::from_millis(30)),
    ];
    let start = flows.iter().map(|(pair, _, _)| pair.time).max().unwrap();
    let link = util::Link::new(25_000_000, 640_000).shared();
    for (index, (pair, _, _)) in flows.iter_mut().enumerate() {
        pair.time = start;
        pair.links[0] = Some(link.clone());
        pair.link_source = index as u8;
        pair.propagation_before_link[0] = before_link;
    }
    // Attach while control packets are already in flight, as graphics demand
    // does on a live terminal. Those packets have no group rate snapshots.
    for (pair, client, _) in &mut flows {
        pair.client_conn_mut(*client).ping();
    }
    let [first, second] = &mut flows;
    util::drive_pairs_until(
        &mut [&mut first.0, &mut second.0],
        start + Duration::from_millis(1),
    );
    let start = start + Duration::from_millis(1);
    let first = &mut flows[0];
    let group = first
        .0
        .client_conn_mut(first.1)
        .start_egress_group_seeded(start, 11)
        .unwrap();
    let second = &mut flows[1];
    second
        .0
        .client_conn_mut(second.1)
        .join_egress_group(&group, EgressClass::Bulk)
        .unwrap();
    let stream = second.0.client_streams(second.1).open(Dir::Uni).unwrap();
    second
        .0
        .client_send(second.1, stream)
        .set_priority(EGRESS_IMAGE_PRIORITY)
        .unwrap();
    let body = vec![0x61; 1024 * 1024];
    let mut written = 0;
    let mut received = 0;
    let mut warm_received = 0;
    let mut accepted = false;
    let mut inputs = 0;
    for tick in 1..=60_000u64 {
        for (index, (pair, _, _)) in flows.iter_mut().enumerate() {
            pair.latency =
                Duration::from_micros(26_250 + (tick * 7_919 + index as u64 * 997 + 11) % 7_501);
        }
        let first = &mut flows[0];
        if tick % input_period == 0 {
            first
                .0
                .client_datagrams(first.1)
                .send(Bytes::copy_from_slice(&tick.to_le_bytes()), false)
                .unwrap();
            first.0.client_conn_mut(first.1).wake_egress();
        }
        let second = &mut flows[1];
        match second
            .0
            .client_send(second.1, stream)
            .write(&body[written % body.len()..])
        {
            Ok(n) => written += n,
            Err(WriteError::Blocked) => {}
            Err(error) => panic!("write failed: {error}"),
        }
        let [first, second] = &mut flows;
        util::drive_pairs_until(
            &mut [&mut first.0, &mut second.0],
            start + Duration::from_millis(tick),
        );
        while first.0.server_datagrams(first.2).recv().is_some() {
            inputs += 1;
        }
        if !accepted {
            accepted = second.0.server_streams(second.2).accept(Dir::Uni).is_some();
        }
        if accepted {
            let mut recv = second.0.server_recv(second.2, stream);
            let mut chunks = recv.read(true).unwrap();
            loop {
                match chunks.next(usize::MAX) {
                    Ok(Some(chunk)) => {
                        assert_eq!(chunk.offset, received as u64);
                        received += chunk.bytes.len();
                    }
                    Err(ReadError::Blocked) => break,
                    result => panic!("unexpected read: {result:?}"),
                }
            }
            let _ = chunks.finalize();
        }
        if tick == 2_000 {
            warm_received = received;
        }
    }
    let goodput = (received - warm_received) as u64 / 58;
    // Stop producing, then deliver the inputs still crossing the simulated hop.
    let [first, second] = &mut flows;
    util::drive_pairs_until(
        &mut [&mut first.0, &mut second.0],
        start + Duration::from_secs(61),
    );
    while first.0.server_datagrams(first.2).recv().is_some() {
        inputs += 1;
    }
    assert_eq!(inputs, 60_000 / input_period);
    assert!(
        goodput >= 25_000_000 / 8 * 80 / 100,
        "goodput={goodput}; model={:?}",
        group.stats()
    );
    let mut residence: Vec<_> = link
        .borrow()
        .log
        .iter()
        .filter(|p| p.source == 0 && p.arrival >= start + Duration::from_secs(2))
        .map(|p| p.residence)
        .collect();
    residence.sort_unstable();
    let p95 = residence[residence.len() * 95 / 100];
    assert!(
        p95 <= Duration::from_millis(3)
            + if before_link {
                Duration::from_micros(7_500)
            } else {
                Duration::ZERO
            },
        "interactive queue p95={p95:?}; input period={input_period} ms; model={:?}",
        group.stats()
    );
}
