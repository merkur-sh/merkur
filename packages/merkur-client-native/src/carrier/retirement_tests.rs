use super::*;

async fn connections() -> (
    Endpoint<wtransport::endpoint::endpoint_side::Server>,
    Endpoint<wtransport::endpoint::endpoint_side::Client>,
    Connection,
    Connection,
) {
    rustls::crypto::ring::default_provider()
        .install_default()
        .unwrap_or_default();
    let identity = wtransport::Identity::self_signed(["localhost"]).unwrap();
    let hash = *identity.certificate_chain().as_slice()[0].hash().as_ref();
    let server = Endpoint::server(
        wtransport::ServerConfig::builder()
            .with_bind_address("127.0.0.1:0".parse().unwrap())
            .with_identity(identity)
            .build(),
    )
    .unwrap();
    let client = Endpoint::client(
        ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(hash)])
            .build(),
    )
    .unwrap();
    let url = format!("https://{}", server.local_addr().unwrap());
    let accept = async { server.accept().await.await.unwrap().accept().await.unwrap() };
    let (edge, peer) = tokio::join!(accept, client.connect(&url));
    (server, client, edge, peer.unwrap())
}

#[tokio::test]
async fn retired_source_returns_reader_slots_and_preserves_successor() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let (_server, _client, edge, peer) = connections().await;
        let (inbound, mut received) = InboundSender::channel();
        let task = tokio::spawn(accept_streams(ConnId(1), peer.clone(), inbound));
        let mut successor = edge.open_uni().await.unwrap().await.unwrap();
        successor.write_all(&[0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 1, 42]).await.unwrap();
        let first = received.control.recv().await.unwrap().into_parts().0;
        assert!(matches!(first, Inbound::Reliable { source: 2, payload, .. } if payload == [42]));
        for value in 0..u8::try_from(MAX_READER_TASKS * 2).unwrap() {
            let mut old = edge.open_uni().await.unwrap().await.unwrap();
            old.write_all(&[0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 1, value]).await.unwrap();
            let event = received.control.recv().await.unwrap().into_parts().0;
            assert!(matches!(event, Inbound::Reliable { source: 1, payload, .. } if payload == [value]));
            old.reset(VarInt::try_from_u64(0x52e4_a40f_a8dc).unwrap()).unwrap();
            successor.write_all(&[0, 0, 0, 1, value]).await.unwrap();
            let event = received.control.recv().await.unwrap().into_parts().0;
            assert!(matches!(event, Inbound::Reliable { source: 2, payload, .. } if payload == [value]));
        }
        assert!(peer.quic_connection().close_reason().is_none());
        println!("retired_source readers_retired=32 successor_records=33 payload_bytes=65 carrier_closes=0");
        task.abort();
        drop(task.await);
    }).await.expect("bounded native retirement");
}

#[tokio::test]
async fn retired_source_keeps_active_lane_faults_terminal() {
    let mut closes = 0;
    for failure in ["fin", "header", "body", "reset", "oversize"] {
        let (_server, _client, edge, peer) = connections().await;
        let (inbound, mut received) = InboundSender::channel();
        let task = tokio::spawn(accept_streams(ConnId(1), peer.clone(), inbound));
        let mut lane = edge.open_uni().await.unwrap().await.unwrap();
        lane.write_all(&[0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 1, 42])
            .await
            .unwrap();
        let event = received.control.recv().await.unwrap().into_parts().0;
        assert!(matches!(event, Inbound::Reliable { payload, .. } if payload == [42]));
        match failure {
            "header" => lane.write_all(&[0]).await.unwrap(),
            "body" => lane.write_all(&[0, 0, 0, 2, 42]).await.unwrap(),
            "oversize" => lane.write_all(&[0x7f, 0xff, 0xff, 0xff]).await.unwrap(),
            _ => (),
        }
        if failure == "reset" {
            lane.reset(VarInt::try_from_u64(0x52e4_a40f_a8dd).unwrap())
                .unwrap();
        } else {
            lane.quic_stream_mut().finish().unwrap();
        }
        let closed = tokio::time::timeout(std::time::Duration::from_secs(2), peer.closed()).await;
        task.abort();
        drop(task.await);
        if closed.is_ok() {
            closes += 1;
        }
        println!(
            "active_lane failure={failure} carrier_closes={}",
            usize::from(closed.is_ok())
        );
    }
    println!("active_lane faults=5 carrier_closes={closes}");
    assert_eq!(closes, 5);
}

#[tokio::test]
async fn retired_source_steady_and_finite_payloads_stay_identical() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let (_server, _client, edge, peer) = connections().await;
        let (inbound, mut received) = InboundSender::channel();
        let task = tokio::spawn(accept_streams(ConnId(1), peer.clone(), inbound.clone()));
        let datagrams = tokio::spawn(read_datagrams(ConnId(1), peer.clone(), inbound.lane(Lane::Pulse), Lane::Pulse));
        let mut streams = Vec::new();
        let mut records = 0;
        let mut payload_bytes = 0;
        for channel in [1, 2, 4] {
            let mut send = edge.open_uni().await.unwrap().await.unwrap();
            send.write_all(&[0, 0, 0, 0, 0, 0, 0, 1, channel]).await.unwrap();
            for len in [0usize, 1, 64, 16384, 65536] {
                let body: Vec<_> = (0..len).map(|index| u8::try_from(index % 256).unwrap()).collect();
                send.write_all(&u32::try_from(len).unwrap().to_be_bytes()).await.unwrap();
                send.write_all(&body).await.unwrap();
                let delivery = if channel == 4 { received.display.recv().await } else { received.control.recv().await };
                let event = delivery.unwrap().into_parts().0;
                assert!(matches!(event, Inbound::Reliable { source: 1, channel: actual, payload, .. }
                    if actual == channel && payload == body));
                records += 1;
                payload_bytes += len;
            }
            streams.push(send);
        }
        for complete in [true, false] {
            let mut send = edge.open_uni().await.unwrap().await.unwrap();
            send.write_all(&[0, 0, 0, 0, 0, 0, 0, 1, 0x87, 0, 0, 0, 3, 7, 8, 9]).await.unwrap();
            let begin = received.display.recv().await.unwrap().into_parts().0;
            assert!(matches!(begin, Inbound::Finite { part: Finite::Begin { channel: 0x87, total: 3 }, .. }));
            let data = received.display.recv().await.unwrap().into_parts().0;
            assert!(matches!(data, Inbound::Finite { part: Finite::Data(bytes), .. } if bytes == [7, 8, 9]));
            if complete { send.quic_stream_mut().finish().unwrap(); }
            else { send.reset(VarInt::from_u32(7)).unwrap(); }
            let end = received.display.recv().await.unwrap().into_parts().0;
            assert!(matches!(end, Inbound::Finite { part: Finite::End { complete: actual }, .. } if actual == complete));
        }
        edge.send_datagram([2, 9, 8, 7]).unwrap();
        let datagram = received.pulse.recv().await.unwrap().into_parts().0;
        assert!(matches!(datagram, Inbound::Datagram { payload, .. } if payload.as_ref() == [2, 9, 8, 7]));
        assert!(peer.quic_connection().close_reason().is_none());
        println!("steady records={records} payload_bytes={payload_bytes} finite_payload_bytes=6 finite_completions=1 finite_aborts=1 datagrams=1 datagram_bytes=4 carrier_closes=0");
        task.abort(); datagrams.abort();
        drop(tokio::join!(task, datagrams));
    }).await.expect("bounded steady native payloads");
}

#[tokio::test]
async fn retired_source_code_is_terminal_on_direct_carriers() {
    let (_server, _client, edge, peer) = connections().await;
    let opening = async { peer.open_bi().await.unwrap().await.unwrap() };
    let (client_stream, server_stream) = tokio::join!(opening, edge.accept_bi());
    let (mut send, mut recv) = server_stream.unwrap();
    let (inbound, mut received) = InboundSender::channel();
    let (writer, pending) = Writer::channel();
    let mut carrier = Carrier {
        _direct_binding: None,
        connection: peer.clone(),
        writers: HashMap::from([(CHANNEL_CTRL, writer)]),
        proof: None,
        direct: true,
        bootstrap: Some(Box::new(Bootstrap {
            conn: ConnId(1),
            inbound,
            streams: BootstrapStreams::Direct(vec![(CHANNEL_CTRL, (client_stream, pending))]),
        })),
        tasks: Vec::new(),
    };
    carrier.activate();
    recv.read_exact(&mut [0; 1]).await.unwrap();
    send.write_all(&[0, 0, 0, 1, 42]).await.unwrap();
    let event = received.control.recv().await.unwrap().into_parts().0;
    assert!(matches!(event, Inbound::Reliable { source: 0, payload, .. } if payload == [42]));
    send.reset(VarInt::try_from_u64(0x52e4_a40f_a8dc).unwrap())
        .unwrap();
    let closed = tokio::time::timeout(std::time::Duration::from_secs(2), peer.closed()).await;
    assert!(closed.is_ok(), "a direct lane accepted relay retirement");
}

#[tokio::test]
async fn retired_source_unclaimed_finite_opens_return_reader_slots() {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let (_server, _client, edge, peer) = connections().await;
        let (inbound, mut received) = InboundSender::channel();
        let task = tokio::spawn(accept_streams(ConnId(1), peer.clone(), inbound));
        for _ in 0..MAX_READER_TASKS * 2 {
            let mut send = edge.open_uni().await.unwrap().await.unwrap();
            send.write_all(&[0, 0, 0, 0]).await.unwrap();
            send.quic_stream().drained().await;
            send.reset(VarInt::from_u32(0)).unwrap();
        }
        let mut successor = edge.open_uni().await.unwrap().await.unwrap();
        successor
            .write_all(&[0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 1, 42])
            .await
            .unwrap();
        let event = received.control.recv().await.unwrap().into_parts().0;
        assert!(matches!(event, Inbound::Reliable { payload, .. } if payload == [42]));
        assert!(peer.quic_connection().close_reason().is_none());
        println!("unclaimed_finite opens_cancelled=32 successor_records=1 carrier_closes=0");
        task.abort();
        drop(task.await);
    })
    .await
    .expect("bounded unclaimed finite opens");
}
