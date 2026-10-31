use super::tests::{MockReliableReader, test_ingress};
use super::*;

#[tokio::test]
async fn retired_source_before_channel_prefix_returns_admission() {
    let (tunnel, edge, _keep) = connected_interactive_test_tunnel().await;
    let conn = tunnel.conn.as_ref().unwrap();
    for position in [0, 4, 8] {
        let mut send = edge.open_uni().await.unwrap().await.unwrap();
        let prefix = [0, 0, 0, 0, 0, 0, 0, 1, CHANNEL_CTRL];
        send.write_all(&prefix[..position]).await.unwrap();
        send.quic_stream().drained().await;
        let recv = conn.accept_uni().await.unwrap();
        send.reset(wtransport::VarInt::try_from_u64(0x52e4_a40f_a8dc).unwrap())
            .unwrap();
        let slots = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&slots).acquire_owned().await.unwrap();
        let result = read_reliable_channel_preface(recv, permit).await;
        println!(
            "retired_source prefix_bytes={position} local_retirement={:?} reader_slots={}",
            result.as_ref().map(Option::is_none),
            slots.available_permits()
        );
        assert!(matches!(result, Ok(None)));
        assert_eq!(slots.available_permits(), 1);
    }
    tunnel.close();
}

#[tokio::test]
async fn retired_source_does_not_close_successor_tunnel() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (tunnel, edge, _keep) = connected_interactive_test_tunnel().await;
        let (ingress, mut received) = test_ingress(1);
        tunnel.spawn_receivers(ingress);
        let mut old = edge.open_uni().await.unwrap().await.unwrap();
        old.write_all(&[0, 0, 0, 0, 0, 0, 0, 1, CHANNEL_CTRL, 0, 0, 0, 1, 41])
            .await
            .unwrap();
        assert_eq!(received.recv().await.unwrap().payload.as_ref(), &[41]);
        old.reset(wtransport::VarInt::try_from_u64(0x52e4_a40f_a8dc).unwrap())
            .unwrap();
        let mut successor = edge.open_uni().await.unwrap().await.unwrap();
        successor
            .write_all(&[0, 0, 0, 0, 0, 0, 0, 2, CHANNEL_CTRL, 0, 0, 0, 1, 42])
            .await
            .unwrap();
        assert_eq!(received.recv().await.unwrap().payload.as_ref(), &[42]);
        successor.write_all(&[0, 0, 0, 1, 43]).await.unwrap();
        assert_eq!(received.recv().await.unwrap().payload.as_ref(), &[43]);
        assert!(!tunnel.closing.load(Ordering::Acquire));
        println!("retired_source successor_records=2 payload_bytes=2 carrier_closes=0");
        tunnel.close();
    })
    .await
    .expect("bounded tunnel retirement");
}

#[tokio::test]
async fn retired_source_keeps_active_tunnel_faults_terminal() {
    let mut closes = 0;
    for failure in ["fin", "header", "body", "reset", "oversize"] {
        let (tunnel, edge, _keep) = connected_interactive_test_tunnel().await;
        let (ingress, mut received) = test_ingress(1);
        tunnel.spawn_receivers(ingress);
        let mut send = edge.open_uni().await.unwrap().await.unwrap();
        send.write_all(&[0, 0, 0, 0, 0, 0, 0, 1, CHANNEL_CTRL, 0, 0, 0, 1, 41])
            .await
            .unwrap();
        assert_eq!(received.recv().await.unwrap().payload.as_ref(), &[41]);
        match failure {
            "header" => send.write_all(&[0]).await.unwrap(),
            "body" => send.write_all(&[0, 0, 0, 2, 42]).await.unwrap(),
            "oversize" => send.write_all(&u32::MAX.to_be_bytes()).await.unwrap(),
            _ => (),
        }
        if failure == "reset" {
            send.reset(wtransport::VarInt::from_u32(7)).unwrap();
        } else {
            send.quic_stream_mut().finish().unwrap();
        }
        let closed = tokio::time::timeout(Duration::from_secs(1), tunnel.closed_reason()).await;
        if closed.is_ok() {
            closes += 1;
        }
        println!(
            "active_tunnel failure={failure} carrier_closes={}",
            usize::from(closed.is_ok())
        );
        tunnel.close();
    }
    println!("active_tunnel faults=5 carrier_closes={closes}");
    assert_eq!(closes, 5);
}

#[tokio::test(flavor = "current_thread")]
async fn retired_source_steady_record_allocations_stay_exact() {
    for (len, fragment) in [
        (0, 16384),
        (1, 16384),
        (64, 16384),
        (1024, 16384),
        (65536, 16384),
        (65536, 257),
    ] {
        let body = vec![0xa5; len];
        let mut wire = Vec::with_capacity(len + 4);
        wire.extend_from_slice(&(len as u32).to_be_bytes());
        wire.extend_from_slice(&body);
        let mut reader = MockReliableReader::new(&wire[1..], fragment);
        test_allocations::begin_thread();
        let payload = read_started_reliable_record(&mut reader, CHANNEL_CTRL, wire[0])
            .await
            .unwrap();
        let tally = test_allocations::end_thread();
        assert_eq!(payload, body);
        assert_eq!(tally.allocations, usize::from(len != 0));
        assert_eq!(tally.allocated_bytes, len);
        println!(
            "steady_tunnel payload_bytes={len} fragment_bytes={fragment} allocations={} allocated_bytes={} error_state_bytes={}",
            tally.allocations,
            tally.allocated_bytes,
            std::mem::size_of::<ReliableLaneTaskError>()
        );
    }
}
