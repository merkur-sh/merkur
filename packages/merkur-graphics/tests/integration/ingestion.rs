//! Protocol cases pinned to kitty 1d67ecd47c0bd68951868c363baa92039d936572,
//! docs/graphics-protocol.rst. These exercise Merkur's ingestion contract,
//! not a claim of full renderer or upstream differential conformance.

use merkur_graphics::command::{
    Action, Chunk, Control, Error, Key, MAX_CHUNK_BYTES, MAX_HEADER_BYTES, Received, Receiver,
};
use merkur_graphics::ingest::{Ingest, Step};
use proptest::prelude::*;

fn command<'a>(header: &[u8], payload: &'a [u8]) -> Received<'a> {
    Received::Chunk(Chunk {
        control: Control::parse(header).unwrap(),
        payload,
    })
}

#[test]
fn native_references_are_single_canonical_commands_not_inline_uploads() {
    let token = [b'a'; 64];
    for header in [b"t=n,i=1".as_slice(), b"t=n,a=T,i=2,p=3", b"t=n,a=q,i=4", b"t=n,a=f,i=5"] {
        let mut ingest = Ingest::new(4096);
        let Step::Data {
            id,
            first: true,
            last: true,
            encoded,
            ..
        } = ingest.accept(command(header, &token))
        else {
            panic!("native boundary");
        };
        assert_eq!(encoded, &token);
        assert!(ingest.validation_pending());
        assert!(ingest.finish_validation(id));
    }
    for header in [
        b"t=n,m=1".as_slice(),
        b"t=n,f=24",
        b"t=n,s=1",
        b"t=n,v=1",
        b"t=n,o=z",
        b"t=n,S=4",
        b"t=n,O=1",
        b"t=n,a=p",
        b"t=n,a=d",
    ] {
        assert!(matches!(
            Ingest::new(4096).accept(command(header, &token)),
            Step::Rejected { .. }
        ));
    }
    for bad in [b"a".as_slice(), &[b'A'; 64], &[b'g'; 64], &[b'0'; 65]] {
        assert!(matches!(
            Ingest::new(4096).accept(command(b"t=n", bad)),
            Step::Rejected { .. }
        ));
    }
    let mut ingest = Ingest::new(4096);
    assert!(matches!(
        ingest.accept(command(b"s=1,v=1,m=1", b"AAAA")),
        Step::Data { .. }
    ));
    assert!(matches!(
        ingest.accept(command(b"t=n", &token)),
        Step::Rejected {
            error: Error::InvalidContinuation,
            ..
        }
    ));
}

#[test]
fn integer_domains_and_presence_do_not_alias() {
    let control = Control::parse(b"i=4294967295,p=0,z=-2147483648,H=2147483647,V=-1,N=1").unwrap();
    assert_eq!(control.get(Key::ImageId), Some(u32::MAX));
    assert_eq!(control.get(Key::PlacementId), Some(0));
    assert_eq!(control.get(Key::ImageNumber), None);
    assert_eq!(control.signed(Key::Z), Some(i32::MIN));
    assert_eq!(control.signed(Key::ParentX), Some(i32::MAX));
    assert_eq!(control.signed(Key::ParentY), Some(-1));
    assert_eq!(control.get(Key::UsageHints), Some(1));
    assert_eq!(
        Control::parse(b"i=00000000000000000001")
            .unwrap()
            .get(Key::ImageId),
        Some(1)
    );
    for invalid in [
        b"i=4294967296".as_slice(),
        b"i=-1",
        b"i=+1",
        b"i= 1",
        b"i=",
        b"z=-",
        b"z=2147483648",
        b"z=-2147483649",
        b"H=4294967295",
        b"i=1,",
        b"i=1,,p=1",
        b"ii=1",
        b"i=1.0",
        b"i=1\0",
        b"a=tt",
        b"a=1",
    ] {
        assert!(Control::parse(invalid).is_err(), "accepted {invalid:?}");
    }
    assert_eq!(Control::parse(b"i=1,i=2"), Err(Error::DuplicateKey));
}

#[test]
fn every_action_and_no_payload_commands_are_recognized() {
    for (value, action) in [
        (b't', Action::Transmit),
        (b'T', Action::TransmitAndPlace),
        (b'p', Action::Place),
        (b'd', Action::Delete),
        (b'q', Action::Query),
        (b'f', Action::Frame),
        (b'a', Action::Animate),
        (b'c', Action::Compose),
    ] {
        assert_eq!(
            Control::parse(&[b'a', b'=', value]).unwrap().action(),
            Ok(action)
        );
    }
    let mut receiver = Receiver::default();
    receiver.start();
    receiver.push(b"Ga=p,U=1,i=42,c=5,r=3");
    let Received::Chunk(chunk) = receiver.finish(true) else {
        panic!("missing command")
    };
    assert_eq!(chunk.control.action(), Ok(Action::Place));
    assert!(chunk.payload.is_empty());
}

#[test]
fn file_and_shared_memory_probes_are_refused_before_payload_ingestion() {
    for medium in *b"ftsx" {
        for split in 0..=10 {
            let header = [
                b'G', b'a', b'=', b'q', b',', b't', b'=', medium, b',', b'i', b'=', b'1', b';',
            ];
            let mut receiver = Receiver::default();
            receiver.start();
            receiver.push(&header[..split]);
            receiver.push(&header[split..]);
            // A refused medium cannot turn into a payload-size error or allocate
            // storage for even a maliciously oversized "path".
            receiver.push(&[b'x'; MAX_CHUNK_BYTES * 2]);
            assert!(
                matches!(receiver.finish(true), Received::Rejected { error: Error::UnsupportedMedium, control: Some(control) } if control.get(Key::ImageId) == Some(1))
            );
        }
    }
}

#[test]
fn staging_bounds_and_recovery_are_exact() {
    let mut receiver = Receiver::default();
    let full_header = format!("Gi={}1;", "0".repeat(MAX_HEADER_BYTES - 3));
    receiver.start();
    receiver.push(full_header.as_bytes());
    assert!(
        matches!(receiver.finish(true), Received::Chunk(Chunk { control, .. }) if control.get(Key::ImageId) == Some(1))
    );
    receiver.start();
    receiver.push(b"Gf=100;");
    receiver.push(&[b'A'; MAX_CHUNK_BYTES]);
    assert!(
        matches!(receiver.finish(true), Received::Chunk(Chunk { payload, .. }) if payload.len() == MAX_CHUNK_BYTES)
    );
    receiver.start();
    receiver.push(b"Gf=100;");
    receiver.push(&[b'A'; MAX_CHUNK_BYTES]);
    receiver.push(b"A");
    assert!(matches!(
        receiver.finish(true),
        Received::Rejected {
            error: Error::ChunkTooLarge,
            ..
        }
    ));
    assert_eq!(receiver.finish(true), Received::Ignored);
    receiver.start();
    receiver.push(b"G");
    receiver.push(&[b'x'; MAX_HEADER_BYTES]);
    receiver.push(b"x");
    assert!(matches!(
        receiver.finish(true),
        Received::Rejected {
            error: Error::HeaderTooLarge,
            control: None
        }
    ));
    receiver.start();
    receiver.push(b"Ga=d");
    assert!(matches!(receiver.finish(true), Received::Chunk(_)));
    receiver.start();
    receiver.push(b"not-graphics");
    receiver.push(&[b'G'; MAX_CHUNK_BYTES * 2]);
    assert_eq!(receiver.finish(true), Received::Ignored);
}

#[test]
fn cancellation_discards_partial_header_and_payload() {
    let mut receiver = Receiver::default();
    for input in [b"Gf=100".as_slice(), b"Gf=100;AAAA", b"Gt=f;AAAA"] {
        receiver.start();
        receiver.push(input);
        assert_eq!(receiver.finish(false), Received::Cancelled);
        assert_eq!(receiver.finish(true), Received::Ignored);
    }
}

#[test]
fn continuation_has_one_identity_and_only_final_chunk_starts_validation() {
    let mut ingest = Ingest::new(12);
    let Step::Data {
        id,
        first: true,
        last: false,
        ..
    } = ingest.accept(command(b"f=100,i=7,m=1,q=1", b"AAAA"))
    else {
        panic!("first")
    };
    assert!(!ingest.validation_pending());
    assert_eq!(ingest.accept(Received::Ignored), Step::Ignored);
    let Step::Data {
        id: next,
        control,
        first: false,
        last: false,
        ..
    } = ingest.accept(command(b"m=1,q=2", b"BBBB"))
    else {
        panic!("continuation")
    };
    assert_eq!(id, next);
    assert_eq!(control.get(Key::ImageId), Some(7));
    assert_eq!(control.quiet(), Ok(2));
    let Step::Data {
        id: final_id,
        first: false,
        last: true,
        ..
    } = ingest.accept(command(b"m=0", b"CCCC"))
    else {
        panic!("last")
    };
    assert_eq!(id, final_id);
    assert!(ingest.validation_pending());
    assert!(matches!(
        ingest.accept(command(b"a=d", b"")),
        Step::Rejected {
            error: Error::ValidationPending,
            ..
        }
    ));
    assert!(ingest.finish_validation(id));
    assert!(!ingest.finish_validation(id));
    assert!(matches!(
        ingest.accept(command(b"a=d", b"")),
        Step::Command { .. }
    ));
}

#[test]
fn malformed_continuation_cancels_without_reinterpreting_a_chunk() {
    for bad in [b"m=0,i=2".as_slice(), b"a=T,m=0", b"m=0,s=1", b"q=1"] {
        let mut ingest = Ingest::new(32);
        assert!(matches!(
            ingest.accept(command(b"f=100,m=1", b"AAAA")),
            Step::Data { .. }
        ));
        assert!(matches!(
            ingest.accept(command(bad, b"BBBB")),
            Step::Rejected {
                error: Error::InvalidContinuation,
                ..
            }
        ));
        // It is no longer a continuation; an unqualified raw upload has no size.
        assert!(matches!(
            ingest.accept(command(b"m=0", b"CCCC")),
            Step::Rejected {
                error: Error::InvalidControl,
                ..
            }
        ));
    }
}

#[test]
fn frames_require_action_on_every_chunk_and_deletion_aborts_receiving() {
    let mut ingest = Ingest::new(32);
    ingest.accept(command(b"a=f,i=7,f=100,m=1", b"AAAA"));
    assert!(matches!(
        ingest.accept(command(b"m=0", b"BBBB")),
        Step::Rejected {
            error: Error::InvalidContinuation,
            ..
        }
    ));
    ingest.accept(command(b"a=f,i=7,f=100,m=1", b"AAAA"));
    assert!(matches!(
        ingest.accept(command(b"a=f,m=1", b"BBBB")),
        Step::Data { .. }
    ));
    assert!(matches!(
        ingest.accept(command(b"a=d", b"")),
        Step::Command { .. }
    ));
    assert!(matches!(
        ingest.accept(command(b"f=100", b"CCCC")),
        Step::Data {
            first: true,
            last: true,
            ..
        }
    ));
}

#[test]
fn encoded_quota_counts_all_chunks_and_overflow_never_wraps() {
    let mut ingest = Ingest::new(7);
    ingest.accept(command(b"f=100,m=1", b"AAAA"));
    assert!(matches!(
        ingest.accept(command(b"m=0", b"BBBB")),
        Step::Rejected {
            error: Error::UploadTooLarge,
            ..
        }
    ));
    assert!(!ingest.validation_pending());
    assert!(matches!(
        ingest.accept(command(b"f=100,m=1", b"AAA")),
        Step::Rejected {
            error: Error::InvalidChunkLength,
            ..
        }
    ));
    assert!(matches!(
        ingest.accept(command(b"f=100,m=1", b"AAAA")),
        Step::Data { .. }
    ));
    assert!(matches!(
        ingest.accept(command(b"m=0", b"BBB")),
        Step::Data { last: true, .. }
    ));
}

#[test]
fn late_validation_cannot_resume_a_successor_or_retired_terminal() {
    let mut ingest = Ingest::new(32);
    let Step::Data { id: old, .. } = ingest.accept(command(b"f=100", b"AAAA")) else {
        panic!()
    };
    ingest.cancel();
    let Step::Data { id: new, .. } = ingest.accept(command(b"f=100", b"BBBB")) else {
        panic!()
    };
    assert!(new.get() > old.get());
    assert!(!ingest.finish_validation(old));
    assert!(ingest.validation_pending());
    ingest.retire();
    ingest.cancel();
    assert!(!ingest.finish_validation(new));
    assert!(matches!(
        ingest.accept(command(b"f=100", b"CCCC")),
        Step::Rejected {
            error: Error::Retired,
            ..
        }
    ));
}

#[test]
fn format_validation_precedes_helper_work() {
    for invalid in [
        b"f=12".as_slice(),
        b"f=24",
        b"f=32,s=1,v=0",
        b"f=100,o=z",
        b"f=100,o=x",
        b"f=100,i=1,I=2",
    ] {
        let mut ingest = Ingest::new(32);
        assert!(matches!(
            ingest.accept(command(invalid, b"AAAA")),
            Step::Rejected { .. }
        ));
        assert!(!ingest.validation_pending());
    }
}

#[test]
fn diagnostic_output_never_contains_image_bytes() {
    let chunk = Chunk {
        control: Control::default(),
        payload: b"sensitive-image",
    };
    assert!(!format!("{chunk:?}").contains("sensitive"));
    let mut ingest = Ingest::new(32);
    let step = ingest.accept(command(b"f=100", b"sensitive-image"));
    assert!(!format!("{step:?}").contains("sensitive"));
}

proptest! {
    #[test]
    fn arbitrary_payload_split_does_not_change_results(
        payload in proptest::collection::vec(any::<u8>(), 0..4200),
        cut in any::<usize>(),
    ) {
        let mut whole = Receiver::default();
        let mut split = Receiver::default();
        whole.start();
        split.start();
        whole.push(b"Gf=100;");
        for byte in b"Gf=100;" { split.push(core::slice::from_ref(byte)); }
        whole.push(&payload);
        let cut = cut % (payload.len() + 1);
        split.push(&payload[..cut]);
        split.push(&payload[cut..]);
        prop_assert_eq!(whole.finish(true), split.finish(true));
    }

    #[test]
    fn arbitrary_control_data_is_bounded_and_split_invariant(
        header in proptest::collection::vec(any::<u8>(), 0..600),
        cut in any::<usize>(),
    ) {
        let mut whole = Receiver::default();
        let mut split = Receiver::default();
        whole.start();
        split.start();
        whole.push(b"G");
        split.push(b"G");
        whole.push(&header);
        let cut = cut % (header.len() + 1);
        split.push(&header[..cut]);
        split.push(&header[cut..]);
        prop_assert_eq!(whole.finish(true), split.finish(true));
    }
}
