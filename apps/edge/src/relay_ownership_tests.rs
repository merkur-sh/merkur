//! Production framing and real QUIC admission oracles. Timings deliberately
//! exclude network delivery; separate relay/E2E tests exercise the full path.

use super::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::future::Future;
use std::task::{Context, Poll, Waker};
use wtransport::endpoint::endpoint_side::Client;
use wtransport::{ClientConfig, Connection, RecvStream, SendStream};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Tally {
    pub(super) allocations: usize,
    pub(super) bytes: usize,
}

thread_local! {
    static ALLOCATIONS: Cell<Option<Tally>> = const { Cell::new(None) };
}

struct Allocator;
#[global_allocator]
static ALLOCATOR: Allocator = Allocator;

fn count(size: usize) {
    let _ = ALLOCATIONS.try_with(|slot| {
        if let Some(mut tally) = slot.get() {
            tally.allocations += 1;
            tally.bytes += size;
            slot.set(Some(tally));
        }
    });
}

// SAFETY: every method hands its arguments unchanged to `System` and returns
// `System`'s answer, so `System`'s own `GlobalAlloc` guarantees hold. `count`
// only updates a const thread-local `Cell`, so it never re-enters the
// allocator, and it could unwind only by overflowing a `usize` tally, which one
// test's allocations cannot reach.
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forward the unchanged allocator contract to System.
        let result = unsafe { System.alloc(layout) };
        if !result.is_null() {
            count(layout.size());
        }
        result
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forward the unchanged allocator contract to System.
        let result = unsafe { System.alloc_zeroed(layout) };
        if !result.is_null() {
            count(layout.size());
        }
        result
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: return the original pointer/layout to its allocator.
        unsafe { System.dealloc(ptr, layout) };
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        // SAFETY: preserve the original allocation and requested new size.
        let result = unsafe { System.realloc(ptr, layout, size) };
        if !result.is_null() {
            count(size);
        }
        result
    }
}

pub(super) fn measured<T>(f: impl FnOnce() -> T) -> (T, Tally) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            ALLOCATIONS.with(|slot| slot.set(None));
        }
    }
    ALLOCATIONS.with(|slot| {
        assert!(slot.get().is_none());
        slot.set(Some(Tally::default()));
    });
    let _reset = Reset;
    let result = f();
    let tally = ALLOCATIONS.with(|slot| slot.get().unwrap());
    (result, tally)
}

fn ready<T>(future: impl Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("isolated admission unexpectedly blocked"),
    }
}

async fn pair() -> (Endpoint<Server>, Endpoint<Client>, Connection, Connection) {
    let cert = EdgeCert::generate(&["localhost"]).unwrap();
    let server = build_server(
        &cert,
        "127.0.0.1:0".parse().unwrap(),
        &EndpointSecret::generate().unwrap(),
    )
    .unwrap();
    let port = server.local_addr().unwrap().port();
    let client = Endpoint::client(
        ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(cert.cert_hash)])
            .build(),
    )
    .unwrap();
    let accept = async { server.accept().await.await.unwrap().accept().await.unwrap() };
    let (local, remote) = tokio::join!(accept, client.connect(format!("https://127.0.0.1:{port}")));
    (server, client, local, remote.unwrap())
}

async fn stream_pair(
    local: &Connection,
    remote: &Connection,
) -> (SendStream, RecvStream, SendStream, RecvStream) {
    let (mut remote_send, remote_recv) = remote.open_bi().await.unwrap().await.unwrap();
    remote_send.write_all(b"!").await.unwrap();
    let (local_send, mut local_recv) = local.accept_bi().await.unwrap();
    local_recv.read_exact(&mut [0u8; 1]).await.unwrap();
    (local_send, local_recv, remote_send, remote_recv)
}

#[tokio::test]
async fn finite_upstream_reset_interrupts_a_blocked_destination_operation() {
    let (_server, _client, local, remote) = pair().await;
    let (_local_send, mut local_recv, mut remote_send, _remote_recv) =
        stream_pair(&local, &remote).await;
    let mut blocked = Box::pin(finite::upstream(
        &mut local_recv,
        std::future::pending::<()>(),
    ));
    std::future::poll_fn(|cx| {
        assert!(blocked.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    remote_send.reset(VarInt::from_u32(17)).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), blocked)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn cancelled_reset_observer_then_fin_leaves_no_stale_reader() {
    let (_server, _client, local, remote) = pair().await;
    let (_local_send, mut local_recv, mut remote_send, _remote_recv) =
        stream_pair(&local, &remote).await;
    let mut observer = Box::pin(local_recv.quic_stream_mut().received_reset());
    std::future::poll_fn(|cx| {
        assert!(observer.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(observer);
    remote_send.write_all(&[4, 5, 6]).await.unwrap();
    remote_send.finish().await.unwrap();
    assert_eq!(
        local_recv.quic_stream_mut().read_to_end(3).await.unwrap(),
        [4, 5, 6]
    );
    assert_eq!(
        local_recv.quic_stream_mut().received_reset().await.unwrap(),
        None
    );
    drop(local_recv);
}

#[tokio::test]
async fn owned_ingress_handles_fragmented_headers_coalesced_records_and_drain() {
    let (_server, _client, local, remote) = pair().await;
    let (_send, mut recv, mut input, _output) = stream_pair(&local, &remote).await;
    let mut pending = Bytes::new();
    input.write_all(&[0]).await.unwrap();
    let first = next_reliable_chunk(&mut recv, &mut pending, RELIABLE_READ_MAX_BYTES)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.len(), 1);
    // The pending parser must neither forward a partial header nor return a
    // record before its remaining header bytes arrive.
    let head = {
        let mut parsing = std::pin::pin!(read_reliable_head(&mut recv, &mut pending, first));
        assert!(
            tokio::time::timeout(Duration::from_millis(5), &mut parsing)
                .await
                .is_err()
        );
        input
            .write_all(b"\0\0\x09abc\x01\x02\x03\x04\x05\x06\0\0\0\x03xyz\0\0\0\0")
            .await
            .unwrap();
        parsing.await.unwrap()
    };
    let remaining = head.remaining();
    assert_eq!(head.body_len(), 9);
    drop(head);
    // Same production drain used when a destination disappears mid-record.
    drain_reliable_body(
        &mut recv,
        &mut pending,
        remaining,
        tokio::time::Instant::now() + Duration::from_secs(3),
    )
    .await
    .unwrap();
    let first = next_reliable_chunk(&mut recv, &mut pending, RELIABLE_READ_MAX_BYTES)
        .await
        .unwrap()
        .unwrap();
    let mut head = read_reliable_head(&mut recv, &mut pending, first)
        .await
        .unwrap();
    assert_eq!(head.body_len(), 3);
    let mut wire = Vec::new();
    for chunk in head.chunks_mut() {
        wire.extend_from_slice(chunk);
    }
    let mut remaining = head.remaining();
    while remaining > 0 {
        let chunk = next_reliable_chunk(&mut recv, &mut pending, remaining)
            .await
            .unwrap()
            .unwrap();
        remaining -= chunk.len();
        wire.extend_from_slice(&chunk);
    }
    assert_eq!(&wire, b"\0\0\0\x03xyz");
    let first = next_reliable_chunk(&mut recv, &mut pending, RELIABLE_READ_MAX_BYTES)
        .await
        .unwrap()
        .unwrap();
    let empty = read_reliable_head(&mut recv, &mut pending, first)
        .await
        .unwrap();
    assert_eq!(empty.body_len(), 0);
    assert_eq!(empty.remaining(), 0);
}

#[tokio::test]
async fn owned_datagram_admission_allocates_nothing_and_preserves_full_queue() {
    let (_server, _client, local, remote) = pair().await;
    let payload = Bytes::from(vec![0x5a; 1100]);
    // Populate queue metadata, then drain before observing allocations.
    for _ in 0..48 {
        local.send_datagram_owned(payload.clone()).unwrap();
    }
    for _ in 0..48 {
        remote.receive_datagram().await.unwrap();
    }
    let (_, copied) = measured(|| local.send_datagram(payload.clone()).unwrap());
    remote.receive_datagram().await.unwrap();
    let (_, owned) = measured(|| local.send_datagram_owned(payload.clone()).unwrap());
    assert_eq!(owned, Tally::default());
    assert!(copied.allocations >= 1 && copied.bytes >= payload.len());
    assert_eq!(&remote.receive_datagram().await.unwrap()[..], &payload[..]);
    // One non-yielding turn fills the actual bounded queue. Failed admission
    // must neither allocate an envelope nor evict any accepted datagram.
    let mut accepted = 0;
    while local.send_datagram_owned(payload.clone()).is_ok() {
        accepted += 1;
    }
    let (refused, tally) = measured(|| local.send_datagram_owned(payload.clone()));
    assert!(refused.is_err());
    assert_eq!(tally, Tally::default());
    for _ in 0..accepted {
        assert_eq!(&remote.receive_datagram().await.unwrap()[..], &payload[..]);
    }
}

fn admit_record(
    send: &mut SendStream,
    wire: &Bytes,
    copied: bool,
    fragment_bytes: usize,
    scratch: &mut [u8; RELIABLE_COPY_BUFFER_BYTES],
) {
    if copied {
        // The former relay wrote the length and scratch-buffer body separately.
        ready(send.write_all(&wire[..4])).unwrap();
        for chunk in wire[4..].chunks(scratch.len()) {
            scratch[..chunk.len()].copy_from_slice(chunk);
            ready(send.write_all(&scratch[..chunk.len()])).unwrap();
        }
    } else {
        let mut remaining = wire.clone();
        let mut first = remaining.split_to(remaining.len().min(fragment_bytes));
        let mut head = RecordHead::new();
        assert!(head.push(&mut first).unwrap());
        ready(send.quic_stream_mut().write_all_chunks(head.chunks_mut())).unwrap();
        while !remaining.is_empty() {
            let mut chunks = [const { Bytes::new() }; RELIABLE_READ_MAX_CHUNKS];
            let mut count = 0;
            let mut budget = RELIABLE_READ_MAX_BYTES;
            while count < chunks.len() && budget > 0 && !remaining.is_empty() {
                let len = remaining.len().min(fragment_bytes).min(budget);
                chunks[count] = remaining.split_to(len);
                count += 1;
                budget -= len;
            }
            ready(
                send.quic_stream_mut()
                    .write_all_chunks(&mut chunks[..count]),
            )
            .unwrap();
        }
    }
}

#[tokio::test]
async fn fused_record_admission_reuses_payload_storage_without_allocating() {
    let (_server, _client, local, remote) = pair().await;
    let (mut send, _recv, _input, mut output) = stream_pair(&local, &remote).await;
    let mut scratch = [0u8; RELIABLE_COPY_BUFFER_BYTES];
    for body_len in [0usize, 57, 256, 1100, 65536] {
        let mut wire = vec![0x5a; body_len + 4];
        wire[..4].copy_from_slice(&(body_len as u32).to_be_bytes());
        let wire = Bytes::from(wire);
        let mut received = vec![0; wire.len()];
        for _ in 0..4 {
            admit_record(
                &mut send,
                &wire,
                false,
                RELIABLE_READ_MAX_BYTES,
                &mut scratch,
            );
            output.read_exact(&mut received).await.unwrap();
        }
        let (_, copied) = measured(|| {
            admit_record(
                &mut send,
                &wire,
                true,
                RELIABLE_READ_MAX_BYTES,
                &mut scratch,
            )
        });
        output.read_exact(&mut received).await.unwrap();
        assert_eq!(received, wire);
        let (_, owned) = measured(|| {
            admit_record(
                &mut send,
                &wire,
                false,
                RELIABLE_READ_MAX_BYTES,
                &mut scratch,
            )
        });
        output.read_exact(&mut received).await.unwrap();
        assert_eq!(received, wire);
        assert_eq!(owned, Tally::default(), "body={body_len}");
        assert_eq!(
            copied.allocations,
            1 + body_len.div_ceil(RELIABLE_COPY_BUFFER_BYTES)
        );
        assert_eq!(copied.bytes, wire.len());
    }
}

#[tokio::test]
#[ignore = "paired release admission profile; run without concurrent builds/tests"]
async fn edge_owned_admission_profile() {
    let (_server, _client, local, remote) = pair().await;
    let (mut send, _recv, _input, mut output) = stream_pair(&local, &remote).await;
    for fragment_bytes in [1100usize, RELIABLE_READ_MAX_BYTES] {
        let mut scratch = [0u8; RELIABLE_COPY_BUFFER_BYTES];
        for body_len in [0usize, 57, 256, 1100, 65536] {
            let mut wire = vec![0x5a; body_len + 4];
            wire[..4].copy_from_slice(&(body_len as u32).to_be_bytes());
            let wire = Bytes::from(wire);
            let mut received = vec![0; wire.len()];
            let mut samples = [Vec::new(), Vec::new()];
            let mut counts = [Tally::default(); 2];
            for round in 0..80 {
                for arm in if round % 2 == 0 {
                    [0, 1, 1, 0]
                } else {
                    [1, 0, 0, 1]
                } {
                    let started = Instant::now();
                    admit_record(&mut send, &wire, arm == 0, fragment_bytes, &mut scratch);
                    let elapsed = started.elapsed().as_nanos();
                    if round >= 20 {
                        samples[arm].push(elapsed);
                    }
                    output.read_exact(&mut received).await.unwrap();
                    assert_eq!(received, wire);
                }
            }
            for arm in 0..2 {
                let (_, tally) = measured(|| {
                    admit_record(&mut send, &wire, arm == 0, fragment_bytes, &mut scratch)
                });
                counts[arm] = tally;
                output.read_exact(&mut received).await.unwrap();
                samples[arm].sort_unstable();
            }
            // Large fragmented records may grow retained QUIC segment metadata.
            // Report it separately; only payload copying is eliminated.
            println!(
                "reliable fragment={fragment_bytes} body={body_len} copied_ns={} owned_ns={} copied_allocs={} copied_bytes={} owned_allocs={} owned_bytes={}",
                samples[0][samples[0].len() / 2],
                samples[1][samples[1].len() / 2],
                counts[0].allocations,
                counts[0].bytes,
                counts[1].allocations,
                counts[1].bytes
            );
        }
    }
    for len in [57usize, 256, 1100] {
        let wire = Bytes::from(vec![0x5a; len]);
        let mut samples = [Vec::new(), Vec::new()];
        for round in 0..80 {
            for arm in if round % 2 == 0 {
                [0, 1, 1, 0]
            } else {
                [1, 0, 0, 1]
            } {
                let start = Instant::now();
                if arm == 0 {
                    assert!(
                        local
                            .quic_connection()
                            .delivery_state()
                            .datagram_send_buffer_space
                            >= len
                    );
                    local.send_datagram(wire.clone()).unwrap();
                } else {
                    local.send_datagram_owned(wire.clone()).unwrap();
                }
                let elapsed = start.elapsed().as_nanos();
                if round >= 20 {
                    samples[arm].push(elapsed);
                }
                assert_eq!(&remote.receive_datagram().await.unwrap()[..], &wire[..]);
            }
        }
        for sample in &mut samples {
            sample.sort_unstable();
        }
        println!(
            "datagram bytes={len} copied_ns={} owned_ns={}",
            samples[0][samples[0].len() / 2],
            samples[1][samples[1].len() / 2]
        );
    }
}

#[tokio::test]
async fn bounded_chunk_reads_preserve_limits_fin_and_cancel_safety() {
    let (_server, _client, local, remote) = pair().await;
    let (_send, mut recv, mut input, _output) = stream_pair(&local, &remote).await;
    let mut chunks = [const { Bytes::new() }; 3];
    assert_eq!(
        recv.quic_stream_mut()
            .read_chunks_bounded(&mut chunks, 0)
            .await
            .unwrap(),
        Some(0)
    );
    assert_eq!(
        recv.quic_stream_mut()
            .read_chunks_bounded(&mut [], 7)
            .await
            .unwrap(),
        Some(0)
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(5),
            recv.quic_stream_mut().read_chunks_bounded(&mut chunks, 4)
        )
        .await
        .is_err()
    );
    input.write_all(b"123456789").await.unwrap();
    input.finish().await.unwrap();
    let mut expected = b"123456789".as_slice();
    for limit in [1usize, 3, 2, 3] {
        let mut remaining = limit;
        while remaining > 0 {
            let count = recv
                .quic_stream_mut()
                .read_chunks_bounded(&mut chunks, remaining)
                .await
                .unwrap()
                .unwrap();
            assert!(count > 0 && count <= chunks.len());
            for chunk in &mut chunks[..count] {
                assert!(chunk.len() <= remaining);
                assert_eq!(&chunk[..], &expected[..chunk.len()]);
                remaining -= chunk.len();
                expected = &expected[chunk.len()..];
                *chunk = Bytes::new();
            }
        }
    }
    assert!(expected.is_empty());
    assert_eq!(
        recv.quic_stream_mut()
            .read_chunks_bounded(&mut chunks, 1)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn fused_control_serialization_reduces_allocations_and_keeps_wire_bytes() {
    let (_server, _client, local, remote) = pair().await;
    let (mut send, _recv, _input, mut output) = stream_pair(&local, &remote).await;
    for event in [
        serde_json::json!({"type":"counterpart_present", "present": true, "counterpart_attachment_id":42}),
        serde_json::to_value(SpliceDeliveryQuoteEvent::from(SpliceDeliveryQuote {
            browser_attachment_id: 42,
            rtt_us: 4000,
            congestion_window_bytes: 64000,
            bytes_in_flight: 11000,
            send_buffer_occupied_bytes: 12000,
            mtu_bytes: 1400,
            pacing_rate_bps: 10000000,
            sent_packets: 6000,
            lost_packets: 2,
            contention: crate::splice::SpliceContention::default(),
            pto_count: 0,
            send_blocked: false,
        }))
        .unwrap(),
    ] {
        let json = serde_json::to_vec(&event).unwrap();
        let mut expected = (json.len() as u32).to_be_bytes().to_vec();
        expected.extend_from_slice(&json);
        let mut received = vec![0; expected.len()];
        ready(write_splice_control_with_timeout(
            &mut send,
            &event,
            Duration::from_secs(2),
        ))
        .unwrap();
        output.read_exact(&mut received).await.unwrap();
        let (_, before) = measured(|| {
            let json = serde_json::to_vec(&event).unwrap();
            ready(send.write_all(&(json.len() as u32).to_be_bytes())).unwrap();
            ready(send.write_all(&json)).unwrap();
        });
        output.read_exact(&mut received).await.unwrap();
        assert_eq!(received, expected);
        let (_, after) = measured(|| {
            ready(write_splice_control_with_timeout(
                &mut send,
                &event,
                Duration::from_secs(2),
            ))
            .unwrap()
        });
        output.read_exact(&mut received).await.unwrap();
        assert_eq!(received, expected);
        assert!(
            after.allocations < before.allocations,
            "{before:?} -> {after:?}"
        );
        assert!(after.bytes < before.bytes, "{before:?} -> {after:?}");
    }
}

#[test]
fn session_local_datagram_routing_reuses_payload_without_steady_state_allocations() {
    let registry = crate::splice::SpliceRegistry::new();
    let browser = registry.attach("owned-route", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
    let mut daemon = registry.attach("owned-route", Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID).unwrap();
    let payload = Bytes::from(vec![0x5a; 1100]);
    let mut route = || {
        assert!(
            browser
                .datagram_route
                .route(Frame::datagram(payload.clone()))
        );
        let received = daemon.datagram_rx.try_recv().unwrap();
        assert_eq!(received.datagrams.payloads()[0].as_ptr(), payload.as_ptr());
        assert_eq!(received.datagrams.payloads()[0], payload);
    };
    // Grow the bounded channel's reusable blocks before steady-state accounting.
    for _ in 0..512 {
        route();
    }
    let (_, tally) = measured(|| {
        for _ in 0..4096 {
            route();
        }
    });
    assert_eq!(tally, Tally::default());
}

/// Isolate the two extra connection locks and driver wake owned by a
/// singleton's transmit hold. Receive and byte validation are outside timing.
#[tokio::test]
#[ignore = "paired release singleton admission profile; run alone"]
async fn singleton_egress_hold_profile() {
    let (_server, _client, local, remote) = pair().await;
    for len in [57usize, 1100] {
        let wire = Bytes::from(vec![0x5a; len]);
        let mut samples = [Vec::new(), Vec::new()];
        let mut counts = [Tally::default(); 2];
        for round in 0..160 {
            for arm in if round % 2 == 0 {
                [0, 1, 1, 0]
            } else {
                [1, 0, 0, 1]
            } {
                let started = Instant::now();
                for _ in 0..8 {
                    let _hold = (arm == 0).then(|| local.hold_egress());
                    local.send_datagram_owned(wire.clone()).unwrap();
                }
                let elapsed = started.elapsed().as_nanos() as u64 / 8;
                if round >= 40 {
                    samples[arm].push(elapsed);
                }
                for _ in 0..8 {
                    assert_eq!(&remote.receive_datagram().await.unwrap()[..], &wire[..]);
                }
            }
        }
        for arm in 0..2 {
            let (_, tally) = measured(|| {
                let _hold = (arm == 0).then(|| local.hold_egress());
                local.send_datagram_owned(wire.clone()).unwrap();
            });
            counts[arm] = tally;
            assert_eq!(&remote.receive_datagram().await.unwrap()[..], &wire[..]);
            assert_eq!(tally, Tally::default());
            samples[arm].sort_unstable();
        }
        println!(
            "@@edge-singleton-profile {}",
            serde_json::json!({
                "bytes":len, "samples":samples[0].len(),
                "held_p50_ns":samples[0][samples[0].len()/2],
                "held_p95_ns":samples[0][samples[0].len()*95/100],
                "held_p99_ns":samples[0][samples[0].len()*99/100],
                "single_p50_ns":samples[1][samples[1].len()/2],
                "single_p95_ns":samples[1][samples[1].len()*95/100],
                "single_p99_ns":samples[1][samples[1].len()*99/100],
                "held_allocations":counts[0].allocations, "single_allocations":counts[1].allocations,
            })
        );
    }
}
