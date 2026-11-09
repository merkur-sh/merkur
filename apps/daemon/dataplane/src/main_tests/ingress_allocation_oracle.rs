use super::*;

/// Exact allocation oracle for the production edge ingress message constructor.
/// Ignored because the counting allocator is process-wide: run it alone.
#[test]
#[ignore = "exact allocation oracle; the counting allocator is process-wide"]
fn edge_datagram_message_is_allocation_free() {
    use crate::edge_tunnel::test_allocations;
    const SAMPLES: usize = 1_000;

    let carrier = bytes::Bytes::from(vec![0x7Au8; 1100]);
    let (tx, _owner) = mpsc::channel(1);
    let ingress = edge_tunnel::EdgeIngress {
        tx,
        peer_node_id: Arc::from("browser-01234567-89ab-cdef-0123-456789abcdef"),
        identity: EdgeIngressIdentity {
            session_id: Arc::from("session-1"),
            generation: 17,
            lane: EdgeLane::Interactive,
        },
    };
    std::hint::black_box(ingress.message(
        carrier[0],
        carrier.slice(1..),
        DeliveryMode::Datagram,
        None,
    ));

    test_allocations::begin();
    for _ in 0..SAMPLES {
        let bytes = carrier.clone();
        let msg = ingress.message(bytes[0], bytes.slice(1..), DeliveryMode::Datagram, None);
        std::hint::black_box(&msg);
    }
    let edge = test_allocations::end();

    assert_eq!(edge.allocations, 0, "edge ingress must not allocate");
    assert_eq!(edge.allocated_bytes, 0);
}
