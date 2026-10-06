use super::*;

/// Exact allocation oracle for inbound datagram ingress.
///
/// A browser display ACK or keystroke arrives at display-frame rate, and
/// every one of them used to be copied out of the carrier's buffer, copied
/// again to strip the one-byte channel prefix, and stamped with a freshly
/// minted peer id. All three are now refcount operations on buffers and
/// ids the carrier already owns.
///
/// Ignored because the counting allocator is process-wide: run it alone.
#[test]
#[ignore = "exact allocation oracle; the counting allocator is process-wide"]
fn inbound_datagram_ingress_is_allocation_free() {
    use crate::edge_tunnel::test_allocations;
    const SAMPLES: usize = 1_000;

    // One QUIC datagram exactly as `Datagram::payload()` hands it over, and
    // a realistically sized peer id that is interned once per connection.
    let carrier = bytes::Bytes::from(vec![0x7Au8; 1100]);
    let interned: Arc<str> = Arc::from("browser-01234567-89ab-cdef-0123-456789abcdef");
    let temp_id: Arc<str> = Arc::from("wt-pending-1");
    let mut temp_to_real: HashMap<String, Arc<str>> = HashMap::new();
    temp_to_real.insert(temp_id.to_string(), Arc::clone(&interned));

    // One untimed pass first: any first-touch lazy initialisation inside
    // the measured region would otherwise be attributed to steady state.
    let warm = |data: bytes::Bytes, peer_id: Arc<str>| {
        std::hint::black_box(PeerMessage {
            input_permit: None,
            peer_node_id: peer_id,
            channel_id: data[0],
            payload: data.slice(1..),
            via_transport: PeerTransport::WebTransport,
            delivery: DeliveryMode::Datagram,
            connection_id: 1,
            edge_ingress: None,
        });
    };
    warm(carrier.clone(), Arc::clone(&interned));

    // Candidate: the production direct-WebTransport ingress sequence.
    test_allocations::begin();
    for _ in 0..SAMPLES {
        let data = carrier.clone();
        let peer_id = Arc::clone(&temp_id);
        let real_id = temp_to_real.get(&*peer_id).cloned().unwrap_or(peer_id);
        let msg = PeerMessage {
            input_permit: None,
            peer_node_id: real_id,
            channel_id: data[0],
            payload: data.slice(1..),
            via_transport: PeerTransport::WebTransport,
            delivery: DeliveryMode::Datagram,
            connection_id: 1,
            edge_ingress: None,
        };
        std::hint::black_box(&msg);
    }
    let direct = test_allocations::end();

    // Candidate: the production edge ingress sequence.
    let (tx, _owner) = mpsc::channel(1);
    let ingress = edge_tunnel::EdgeIngress {
        tx,
        peer_node_id: Arc::clone(&interned),
        identity: EdgeIngressIdentity {
            session_id: Arc::from("session-1"),
            generation: 17,
            lane: EdgeLane::Interactive,
        },
    };
    test_allocations::begin();
    for _ in 0..SAMPLES {
        let bytes = carrier.clone();
        let msg = ingress.message(bytes[0], bytes.slice(1..), DeliveryMode::Datagram, None);
        std::hint::black_box(&msg);
    }
    let edge = test_allocations::end();

    // Superseded shape, measured in the same process so the delta is
    // observed rather than asserted: copy out of the carrier, copy again to
    // strip the channel byte, and mint the id twice.
    test_allocations::begin();
    for _ in 0..SAMPLES {
        let data = carrier.to_vec();
        let peer_id = temp_id.to_string();
        let real_id = temp_to_real
            .get(&peer_id)
            .map(|id| id.to_string())
            .unwrap_or(peer_id);
        let msg = PeerMessage {
            input_permit: None,
            peer_node_id: Arc::from(real_id.as_str()),
            channel_id: data[0],
            payload: bytes::Bytes::from(data[1..].to_vec()),
            via_transport: PeerTransport::WebTransport,
            delivery: DeliveryMode::Datagram,
            connection_id: 1,
            edge_ingress: None,
        };
        std::hint::black_box(&msg);
    }
    let baseline = test_allocations::end();

    println!(
        "direct-WT ingress allocations/datagram: {:.3} -> {:.3}; bytes/datagram: {:.1} -> {:.1}",
        baseline.allocations as f64 / SAMPLES as f64,
        direct.allocations as f64 / SAMPLES as f64,
        baseline.allocated_bytes as f64 / SAMPLES as f64,
        direct.allocated_bytes as f64 / SAMPLES as f64,
    );
    println!(
        "edge ingress allocations/datagram: {:.3}; bytes/datagram: {:.1}",
        edge.allocations as f64 / SAMPLES as f64,
        edge.allocated_bytes as f64 / SAMPLES as f64,
    );
    assert_eq!(direct.allocations, 0, "direct-WT ingress must not allocate");
    assert_eq!(direct.allocated_bytes, 0);
    assert_eq!(edge.allocations, 0, "edge ingress must not allocate");
    assert_eq!(edge.allocated_bytes, 0);
    assert!(baseline.allocations > direct.allocations);
}
