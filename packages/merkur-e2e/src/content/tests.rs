use super::*;

fn pair(epoch: u8) -> (NoiseTransport, NoiseTransport) {
    let a = [0x11; 32];
    let b = [0x22; 32];
    let make = |send, receive, initiator| {
        NoiseTransport::new(
            transport_cipher(send).unwrap(),
            transport_cipher(receive).unwrap(),
            ContentDomain::new(send, receive, &[epoch; 64], initiator).unwrap(),
        )
    };
    (make(&a, &b, true), make(&b, &a, false))
}

fn descriptor(bytes: usize, first: u32, count: u32) -> ContentDescriptor {
    ContentDescriptor::new(17, [0x33; 32], [0x44; 32], bytes as u32, first, count).unwrap()
}

// Crypto tests construct local exact authority for each independent admission;
// request-owner lifecycle is exercised separately below with a persistent table.
fn receive_exact(
    owner: &mut NoiseTransport,
    descriptor: ContentDescriptor,
    header: &[u8],
) -> Result<ContentReceiver, ContentError> {
    let mut requests = ContentRequests::default();
    requests.range(descriptor).unwrap();
    owner.content_receiver(&mut requests, header)
}

fn seal(sender: &mut ContentSender, bytes: &[u8]) -> Vec<u8> {
    let mut wire = vec![0; bytes.len() + CONTENT_CHUNK_OVERHEAD];
    assert_eq!(sender.seal_next(bytes, &mut wire).unwrap(), wire.len());
    wire
}

#[test]
fn shape_is_bounded_and_exact_before_any_allocation() {
    let valid = descriptor(CONTENT_MAX_OBJECT_BYTES, 0, MAX_CHUNKS as u32);
    assert_eq!(ContentDescriptor::decode(valid.encode()), Ok(valid));
    for end in 0..CONTENT_DESCRIPTOR_BYTES {
        assert_eq!(
            ContentDescriptor::decode(&valid.encode()[..end]),
            Err(ContentError::Invalid)
        );
    }
    for (bytes, first, count) in [
        (0, 0, 1),
        (u32::MAX, 0, 1),
        (1, 0, 0),
        (1, 1, 1),
        (1, 0, u32::MAX),
    ] {
        assert_eq!(
            ContentDescriptor::new(1, [0; 32], [0; 32], bytes, first, count),
            Err(ContentError::Invalid)
        );
    }
    assert!(ContentDescriptor::new(0, [0; 32], [0; 32], 1, 0, 1).is_err());
    let tail = descriptor(CONTENT_CHUNK_BYTES * 2 + 7, 1, 2);
    assert_eq!(
        tail.range(),
        CONTENT_CHUNK_BYTES..CONTENT_CHUNK_BYTES * 2 + 7
    );
    assert_eq!(
        tail.wire_bytes(),
        CONTENT_HEADER_BYTES + CONTENT_CHUNK_BYTES + 7 + 2 * CONTENT_CHUNK_OVERHEAD
    );
}

#[test]
fn reserved_response_keys_are_bounded_single_use_and_retire_with_the_epoch() {
    let (mut a, mut b) = pair(5);
    let mut keys: Vec<_> = (0..CONTENT_MAX_TRANSFERS)
        .map(|_| a.reserve_content_sender().unwrap())
        .collect();
    assert!(matches!(
        a.reserve_content_sender(),
        Err(ContentError::Capacity)
    ));
    let abandoned = keys.pop().unwrap();
    drop(abandoned);
    let replacement = a.reserve_content_sender().unwrap();
    let desc = descriptor(1, 0, 1);
    let mut tx = replacement.bind(desc).unwrap();
    assert_eq!(
        u64::from_be_bytes(tx.header()[..8].try_into().unwrap()),
        u64::from(CONTENT_MAX_TRANSFERS) + 1
    );
    let mut rx = receive_exact(&mut b, desc, tx.header()).unwrap();
    let chunk = seal(&mut tx, &[9]);
    assert_eq!(rx.open_chunk(&chunk, &mut [0; 17]).unwrap().len, 1);
    drop(a);
    for key in keys {
        assert!(matches!(key.bind(desc), Err(ContentError::Retired)));
    }
    assert_eq!(tx.seal_next(&[9], &mut [0; 21]), Err(ContentError::Retired));
}

#[test]
fn both_directions_allow_reordered_chunks_and_authenticate_duplicates() {
    let (mut a, mut b) = pair(5);
    for reverse in [false, true] {
        let (sender, receiver) = if reverse {
            (&mut b, &mut a)
        } else {
            (&mut a, &mut b)
        };
        let desc = descriptor(CONTENT_CHUNK_BYTES * 2 + 7, 1, 2);
        let mut tx = sender.content_sender(desc).unwrap();
        let mut rx = receive_exact(receiver, desc, tx.header()).unwrap();
        let first = seal(&mut tx, &vec![0x91; CONTENT_CHUNK_BYTES]);
        let last = seal(&mut tx, &[0x73; 7]);
        let mut out = vec![0; CONTENT_CHUNK_BYTES + 16];
        assert_eq!(
            rx.open_chunk(&last, &mut out).unwrap(),
            ContentChunk {
                object_index: 2,
                len: 7,
                duplicate: false
            }
        );
        assert_eq!(&out[..7], &[0x73; 7]);
        assert_eq!(
            rx.open_chunk(&first, &mut out).unwrap(),
            ContentChunk {
                object_index: 1,
                len: CONTENT_CHUNK_BYTES,
                duplicate: false
            }
        );
        assert!(out[..CONTENT_CHUNK_BYTES].iter().all(|b| *b == 0x91));
        assert!(rx.open_chunk(&last, &mut out).unwrap().duplicate);
        let mut corrupt = last.clone();
        corrupt[5] ^= 1;
        assert_eq!(rx.open_chunk(&corrupt, &mut out), Err(ContentError::Auth));
        assert!(out[..23].iter().all(|byte| *byte == 0));
        assert!(rx.open_chunk(&last, &mut out).unwrap().duplicate);
        assert_eq!(
            tx.seal_next(&[0x73; 7], &mut out),
            Err(ContentError::Invalid)
        );
    }
}

#[test]
fn invalid_lengths_do_not_consume_nonces_and_spliced_ordinals_fail_authentication() {
    let (mut a, mut b) = pair(5);
    let desc = descriptor(CONTENT_CHUNK_BYTES * 2, 0, 2);
    let mut tx = a.content_sender(desc).unwrap();
    let mut rx = receive_exact(&mut b, desc, tx.header()).unwrap();
    let mut out = vec![0x55; CONTENT_CHUNK_BYTES + CONTENT_CHUNK_OVERHEAD];
    assert_eq!(tx.seal_next(&[1], &mut out), Err(ContentError::Invalid));
    assert!(out.iter().all(|b| *b == 0x55));
    assert_eq!(tx.next_ordinal(), 0);
    assert_eq!(
        tx.seal_next(&vec![1; CONTENT_CHUNK_BYTES], &mut out[..4]),
        Err(ContentError::Invalid)
    );
    let first = seal(&mut tx, &vec![1; CONTENT_CHUNK_BYTES]);
    let last = seal(&mut tx, &vec![2; CONTENT_CHUNK_BYTES]);
    let mut spliced = first.clone();
    spliced[..4].copy_from_slice(&1u32.to_be_bytes());
    assert_eq!(rx.open_chunk(&spliced, &mut out), Err(ContentError::Auth));
    assert!(!rx.open_chunk(&last, &mut out).unwrap().duplicate);
    assert!(!rx.open_chunk(&first, &mut out).unwrap().duplicate);
}

#[test]
fn descriptor_authentication_binds_request_source_object_range_direction_and_epoch() {
    let (mut a, mut b) = pair(5);
    let desc = descriptor(CONTENT_CHUNK_BYTES * 3, 0, 2);
    let tx = a.content_sender(desc).unwrap();
    for offset in 0..CONTENT_HEADER_BYTES {
        let mut corrupt = *tx.header();
        corrupt[offset] ^= 1;
        assert!(receive_exact(&mut b, desc, &corrupt).is_err());
    }
    for offset in [7, 8, 40, 75, 79, 83] {
        let mut wrong = *desc.encode();
        wrong[offset] ^= 1;
        let wrong = ContentDescriptor::decode(&wrong).unwrap();
        assert!(matches!(
            receive_exact(&mut b, wrong, tx.header()),
            Err(ContentError::Auth)
        ));
    }
    assert!(matches!(
        receive_exact(&mut a, desc, tx.header()),
        Err(ContentError::Auth)
    ));
    let (_, mut successor) = pair(6);
    assert!(matches!(
        receive_exact(&mut successor, desc, tx.header()),
        Err(ContentError::Auth)
    ));
    let _rx = receive_exact(&mut b, desc, tx.header()).unwrap();
    let mut corrupt_duplicate = *tx.header();
    corrupt_duplicate[CONTENT_HEADER_BYTES - 1] ^= 1;
    assert!(matches!(
        receive_exact(&mut b, desc, &corrupt_duplicate),
        Err(ContentError::Auth)
    ));
    assert!(matches!(
        receive_exact(&mut b, desc, tx.header()),
        Err(ContentError::Replay)
    ));
}

#[test]
fn identical_object_ranges_still_use_distinct_transfer_keys() {
    let (mut a, mut b) = pair(5);
    let desc = descriptor(7, 0, 1);
    let mut first = a.content_sender(desc).unwrap();
    let mut second = a.content_sender(desc).unwrap();
    let mut first_rx = receive_exact(&mut b, desc, first.header()).unwrap();
    let mut second_rx = receive_exact(&mut b, desc, second.header()).unwrap();
    let first_wire = seal(&mut first, &[7; 7]);
    let second_wire = seal(&mut second, &[7; 7]);
    assert_ne!(first_wire, second_wire);
    let mut out = [0; 23];
    assert_eq!(
        first_rx.open_chunk(&second_wire, &mut out),
        Err(ContentError::Auth)
    );
    assert_eq!(
        second_rx.open_chunk(&first_wire, &mut out),
        Err(ContentError::Auth)
    );
    assert!(
        !first_rx
            .open_chunk(&first_wire, &mut out)
            .unwrap()
            .duplicate
    );
    assert!(
        !second_rx
            .open_chunk(&second_wire, &mut out)
            .unwrap()
            .duplicate
    );
}

#[test]
fn admission_is_bounded_and_refusals_do_not_spend_identity_or_replay_state() {
    let (mut a, mut b) = pair(5);
    let desc = descriptor(1, 0, 1);
    let mut senders: Vec<_> = (0..CONTENT_MAX_TRANSFERS)
        .map(|_| a.content_sender(desc).unwrap())
        .collect();
    let next = a.content.next;
    assert!(matches!(
        a.content_sender(desc),
        Err(ContentError::Capacity)
    ));
    assert_eq!(a.content.next, next);
    let mut receivers: Vec<_> = senders
        .iter()
        .map(|tx| receive_exact(&mut b, desc, tx.header()).unwrap())
        .collect();
    senders.pop();
    let tx = a.content_sender(desc).unwrap();
    assert!(matches!(
        receive_exact(&mut b, desc, tx.header()),
        Err(ContentError::Capacity)
    ));
    receivers.pop();
    let _rx = receive_exact(&mut b, desc, tx.header()).unwrap();
    assert!(matches!(
        receive_exact(&mut b, desc, tx.header()),
        Err(ContentError::Replay)
    ));
    drop(senders);
    a.content.next = u64::MAX - 1;
    let last = a.content_sender(desc).unwrap();
    assert_eq!(&last.header()[..8], &(u64::MAX - 1).to_be_bytes());
    assert!(matches!(
        a.content_sender(desc),
        Err(ContentError::Exhausted)
    ));
}

#[test]
fn late_chunks_survive_unrelated_traffic_and_transfer_retirement_does_not_reopen_replay() {
    let (mut a, mut b) = pair(5);
    let desc = descriptor(1, 0, 1);
    let mut tx = a.content_sender(desc).unwrap();
    let mut rx = receive_exact(&mut b, desc, tx.header()).unwrap();
    let chunk = seal(&mut tx, &[7]);
    for _ in 0..2048 {
        let record = a.seal_stream(1, b"control").unwrap();
        b.open_stream(1, &record).unwrap();
        let other = a.content_sender(desc).unwrap();
        receive_exact(&mut b, desc, other.header()).unwrap();
    }
    let mut out = [0; 17];
    assert!(!rx.open_chunk(&chunk, &mut out).unwrap().duplicate);
    drop(rx);
    assert!(matches!(
        receive_exact(&mut b, desc, tx.header()),
        Err(ContentError::Replay)
    ));
}

#[test]
fn epoch_retirement_disables_retained_transfer_owners() {
    let (mut a, mut b) = pair(5);
    let desc = descriptor(CONTENT_CHUNK_BYTES + 1, 0, 2);
    let mut tx = a.content_sender(desc).unwrap();
    let mut rx = receive_exact(&mut b, desc, tx.header()).unwrap();
    let chunk = seal(&mut tx, &vec![8; CONTENT_CHUNK_BYTES]);
    let mut out = vec![0; CONTENT_CHUNK_BYTES + CONTENT_CHUNK_OVERHEAD];
    drop(a);
    assert_eq!(tx.seal_next(&[8], &mut out), Err(ContentError::Retired));
    assert!(rx.open_chunk(&chunk, &mut out).is_ok());
    drop(b);
    assert_eq!(rx.open_chunk(&chunk, &mut out), Err(ContentError::Retired));
}

#[test]
fn whole_requests_authenticate_metadata_before_consuming_live_authority() {
    let (mut a, mut b) = pair(5);
    let mut requests = ContentRequests::default();
    requests.whole(17, [0x33; 32], 37).unwrap();
    for wrong in [
        ContentDescriptor::new(18, [0x33; 32], [0x44; 32], 37, 0, 1).unwrap(),
        ContentDescriptor::new(17, [0x34; 32], [0x44; 32], 37, 0, 1).unwrap(),
        ContentDescriptor::new(17, [0x33; 32], [0x44; 32], 38, 0, 1).unwrap(),
    ] {
        let tx = a.content_sender(wrong).unwrap();
        assert!(matches!(
            b.content_receiver(&mut requests, tx.header()),
            Err(ContentError::Auth)
        ));
    }
    let desc = descriptor(37, 0, 1);
    let mut tx = a.content_sender(desc).unwrap();
    for offset in 0..CONTENT_HEADER_BYTES {
        let mut corrupt = *tx.header();
        corrupt[offset] ^= 1;
        assert!(b.content_receiver(&mut requests, &corrupt).is_err());
    }
    let mut rx = b.content_receiver(&mut requests, tx.header()).unwrap();
    assert_eq!(rx.descriptor(), desc);
    assert!(!requests.cancel(17));
    assert_eq!(
        requests.whole(17, [0x33; 32], 37),
        Err(ContentError::Replay)
    );
    let duplicate = a.content_sender(desc).unwrap();
    assert!(matches!(
        b.content_receiver(&mut requests, duplicate.header()),
        Err(ContentError::Auth)
    ));
    let chunk = seal(&mut tx, &[7; 37]);
    let mut out = [0; 53];
    assert_eq!(rx.open_chunk(&chunk, &mut out).unwrap().len, 37);
    assert_eq!(&out[..37], &[7; 37]);
}

#[test]
fn whole_response_cannot_be_partial_and_cancelled_requests_never_revive() {
    let (mut a, mut b) = pair(5);
    let mut requests = ContentRequests::default();
    requests
        .whole(17, [0x33; 32], (CONTENT_CHUNK_BYTES * 2) as u32)
        .unwrap();
    for (first, count) in [(0, 1), (1, 1)] {
        let tx = a
            .content_sender(descriptor(CONTENT_CHUNK_BYTES * 2, first, count))
            .unwrap();
        assert!(matches!(
            b.content_receiver(&mut requests, tx.header()),
            Err(ContentError::Auth)
        ));
    }
    let tx = a
        .content_sender(descriptor(CONTENT_CHUNK_BYTES * 2, 0, 2))
        .unwrap();
    assert!(requests.cancel(17));
    assert!(!requests.cancel(17));
    assert!(matches!(
        b.content_receiver(&mut requests, tx.header()),
        Err(ContentError::Auth)
    ));
    assert_eq!(requests.range(tx.descriptor()), Err(ContentError::Replay));
    requests.whole(u64::MAX, [0x33; 32], 1).unwrap();
    assert!(requests.cancel(u64::MAX));
    assert_eq!(requests.whole(1, [0x33; 32], 1), Err(ContentError::Replay));
}

#[test]
fn resumed_request_cannot_change_object_length_or_range() {
    let (mut a, mut b) = pair(5);
    let mut requests = ContentRequests::default();
    let expected = descriptor(CONTENT_CHUNK_BYTES * 3, 1, 1);
    requests.range(expected).unwrap();
    for offset in [7, 8, 40, 75, 79, 83] {
        let mut wrong = *expected.encode();
        wrong[offset] ^= if offset == 83 { 3 } else { 1 };
        let tx = a
            .content_sender(ContentDescriptor::decode(&wrong).unwrap())
            .unwrap();
        assert!(matches!(
            b.content_receiver(&mut requests, tx.header()),
            Err(ContentError::Auth)
        ));
    }
    let tx = a.content_sender(expected).unwrap();
    assert_eq!(
        b.content_receiver(&mut requests, tx.header())
            .unwrap()
            .descriptor(),
        expected
    );
    assert!(!requests.cancel(expected.request()));
}

#[test]
fn pending_request_capacity_and_transfer_capacity_preserve_refused_work() {
    let (mut a, mut b) = pair(5);
    let mut requests = ContentRequests::default();
    for (request, bytes) in [(0, 1), (1, 0), (1, u32::MAX)] {
        assert_eq!(
            requests.whole(request, [3; 32], bytes),
            Err(ContentError::Invalid)
        );
    }
    for request in 1..=u64::from(CONTENT_MAX_TRANSFERS) {
        requests.whole(request, [3; 32], 1).unwrap();
    }
    assert_eq!(requests.whole(33, [3; 32], 1), Err(ContentError::Capacity));
    let make = |request| ContentDescriptor::new(request, [3; 32], [4; 32], 1, 0, 1).unwrap();
    let mut receivers = Vec::new();
    // Responses can arrive in reverse request order. Request IDs do not order streams.
    for request in (1..=u64::from(CONTENT_MAX_TRANSFERS)).rev() {
        let tx = a.content_sender(make(request)).unwrap();
        receivers.push(b.content_receiver(&mut requests, tx.header()).unwrap());
    }
    requests.whole(33, [3; 32], 1).unwrap();
    let tx = a.content_sender(make(33)).unwrap();
    assert!(matches!(
        b.content_receiver(&mut requests, tx.header()),
        Err(ContentError::Capacity)
    ));
    receivers.pop();
    let _rx = b.content_receiver(&mut requests, tx.header()).unwrap();
    assert!(!requests.cancel(33));
}

fn vector() -> serde_json::Value {
    let (mut a, mut b) = pair(5);
    let desc = descriptor(37, 0, 1);
    let plaintext: Vec<_> = (0..37).map(|v| v * 7).collect();
    let hex = |bytes: &[u8]| bytes.iter().map(|v| format!("{v:02x}")).collect::<String>();
    let records: Vec<_> = [&mut a, &mut b]
        .into_iter()
        .map(|owner| {
            let mut tx = owner.content_sender(desc).unwrap();
            let record = seal(&mut tx, &plaintext);
            serde_json::json!({ "header_hex": hex(tx.header()), "chunk_hex": hex(&record) })
        })
        .collect();
    serde_json::json!({ "i2r_split_hex": hex(&[0x11; 32]), "r2i_split_hex": hex(&[0x22; 32]),
        "epoch_hex": hex(&[5; 64]), "descriptor_hex": hex(desc.encode()), "plaintext_hex": hex(&plaintext),
        "initiator_to_responder": records[0], "responder_to_initiator": records[1] })
}

#[test]
fn committed_content_vector_reproduces() {
    let path = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("test manifest directory"),
    )
    .join("../shared/test-vectors/content-transfer.json");
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(vector(), expected);
}

#[test]
#[ignore = "explicit regeneration of the content wire contract"]
fn write_content_vector() {
    let path = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("test manifest directory"),
    )
    .join("../shared/test-vectors/content-transfer.json");
    std::fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&vector()).unwrap()),
    )
    .unwrap();
}
