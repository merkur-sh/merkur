//! The delivery state a runtime publishes for readers that must not take the connection's lock.
use super::*;

fn assert_reads_the_statistics_sources(pair: &mut Pair, client: ConnectionHandle) {
    let conn = pair.client_conn_mut(client);
    let (stats, state) = (conn.stats(), conn.delivery_state());
    assert_eq!(state.rtt, stats.path.rtt);
    assert_eq!(state.cwnd, stats.path.cwnd);
    assert_eq!(state.bytes_in_flight, stats.path.bytes_in_flight);
    assert_eq!(state.pacing_rate, stats.path.pacing_rate);
    assert_eq!(state.current_mtu, stats.path.current_mtu);
    assert_eq!(state.pto_count, stats.path.pto_count);
    assert_eq!(state.sent_packets, stats.path.sent_packets);
    assert_eq!(state.lost_packets, stats.path.lost_packets);
    assert_eq!(
        state.datagram_send_buffer_space,
        pair.client_datagrams(client).send_buffer_space()
    );
}

/// Through a queued datagram, a transfer into a black hole (probes back off, packets are
/// declared lost) and its recovery, every field equals the statistics report's.
#[test]
fn delivery_state_reads_the_statistics_sources_through_loss_and_probes() {
    let _guard = subscribe();
    let mut pair = Pair::default();
    let (client, _server) = pair.connect();
    assert_reads_the_statistics_sources(&mut pair, client);

    pair.client_datagrams(client)
        .send(Bytes::from_static(b"queued"), false)
        .unwrap();
    assert_reads_the_statistics_sources(&mut pair, client);

    let stream = pair.client_streams(client).open(Dir::Uni).unwrap();
    pair.client_send(client, stream)
        .write(&[0x42; 100_000])
        .unwrap();
    // Every datagram now exceeds the link's MTU and is dropped, until two probes expired
    pair.mtu = 0;
    while pair.client_conn_mut(client).delivery_state().pto_count < 2 {
        assert!(pair.step());
        assert_reads_the_statistics_sources(&mut pair, client);
    }
    let blackholed = pair.client_conn_mut(client).delivery_state();
    assert!(blackholed.bytes_in_flight > 0, "{blackholed:?}");

    pair.mtu = util::DEFAULT_MTU;
    pair.client_send(client, stream).finish().unwrap();
    while pair.step() {
        assert_reads_the_statistics_sources(&mut pair, client);
    }
    let recovered = pair.client_conn_mut(client).delivery_state();
    assert!(recovered.lost_packets > 0, "{recovered:?}");
    assert_eq!(recovered.pto_count, 0, "{recovered:?}");
}
