//! The same targets run as bounded unit tests and coverage-guided Bolero campaigns.
use merkur_wire::{input_record, protocol::*};

mod seeds {
    include!("seeds.rs");
}
mod bounded {
    include!("bounded.rs");
}
use bounded::bounded;

#[test]
fn fuzz_wire() {
    let focus = [(input_record::KIND_FOCUS << 5) | 1];
    let input_run = encode_probed_input_run(1, false, Some(7), &[(&focus, false)]);
    let seeds = vec![
        (
            "encoder-proto",
            encode_proto_frame(MSG_TYPE_INPUT_RUN, &input_run[PROTO_HEADER_BYTES..]),
        ),
        (
            "encoder-hello",
            encode_data_handshake_frame(DataHandshakeKind::Hello, &[3; DATA_HANDSHAKE_NONCE_BYTES])
                .to_vec(),
        ),
        (
            "encoder-ack",
            encode_data_handshake_frame(DataHandshakeKind::Ack, &[3; DATA_HANDSHAKE_NONCE_BYTES])
                .to_vec(),
        ),
        (
            "encoder-input-run-body",
            input_run[PROTO_HEADER_BYTES..].to_vec(),
        ),
        ("encoder-input-record", focus.to_vec()),
    ];
    seeds::persist(&seeds);
    let check = |bytes: &[u8]| {
        // Valid frames reach the deeper parsers even from an empty corpus.
        let kind = bytes.first().copied().unwrap_or(MSG_TYPE_INPUT_RUN);
        let proto = encode_proto_frame(kind, bytes);
        assert_eq!(decode_proto_frame(&proto), Some((kind, bytes)));
        let mut nonce = [0; DATA_HANDSHAKE_NONCE_BYTES];
        let copied = bytes.len().min(nonce.len());
        nonce[..copied].copy_from_slice(&bytes[..copied]);
        for handshake in [DataHandshakeKind::Hello, DataHandshakeKind::Ack] {
            let encoded = encode_data_handshake_frame(handshake, &nonce);
            assert_eq!(
                decode_data_handshake_frame(&encoded),
                Some((handshake, nonce))
            );
        }
        let focus = [(input_record::KIND_FOCUS << 5) | (kind & 1)];
        let entries: Vec<_> = (0..usize::from(kind % 32 + 1))
            .map(|index| (&focus[..], index % 2 == 0))
            .collect();
        let probe = (kind & 2 != 0).then_some(u64::from(kind));
        let encoded = encode_probed_input_run(1, kind & 1 != 0, probe, &entries);
        let (header, parsed) =
            parse_input_run(&encoded[PROTO_HEADER_BYTES..]).expect("bounded canonical input run");
        assert_eq!(header.probe, probe);
        assert_eq!(header.count as usize, entries.len());
        for (parsed, expected) in parsed.zip(entries) {
            assert_eq!(parsed.payload, expected.0);
            assert_eq!(parsed.shadow_modelled, expected.1);
        }
        if let Some((kind, body)) = decode_proto_frame(bytes) {
            assert_eq!(encode_proto_frame(kind, body), bytes);
            let mut trailing = bytes.to_vec();
            trailing.push(0);
            assert!(decode_proto_frame(&trailing).is_none());
            assert!(decode_proto_frame(&bytes[..bytes.len() - 1]).is_none());
        }
        if let Some((kind, nonce)) = decode_data_handshake_frame(bytes) {
            assert_eq!(encode_data_handshake_frame(kind, &nonce), bytes);
        }
        assert_eq!(
            input_record::validate(bytes),
            input_record::decode(bytes).is_some()
        );
        if let Some((header, entries)) = parse_input_run(bytes) {
            let entries: Vec<_> = entries
                .map(|entry| {
                    assert!(input_record::decode(entry.payload).is_some());
                    (entry.payload, entry.shadow_modelled)
                })
                .collect();
            assert_eq!(entries.len(), usize::from(header.count));
            let encoded =
                encode_probed_input_run(header.base_seq, header.retransmit, header.probe, &entries);
            assert_eq!(&encoded[PROTO_HEADER_BYTES..], bytes);
            let mut trailing = bytes.to_vec();
            trailing.push(0);
            assert!(parse_input_run(&trailing).is_none());
            assert!(parse_input_run(&bytes[..bytes.len() - 1]).is_none());
        }
    };
    for (_, seed) in &seeds {
        check(seed);
    }
    bolero::check!().with_max_len(4096).for_each(check);
}

// Bounded proofs: the random engine runs each closure in `cargo test`, and Kani
// proves the ones `targets.json` lists for every input up to the stated length.
// Each keeps one property, so a counterexample names the property it broke.

/// The 24-bit header declares the whole frame: an accepted frame re-encodes to
/// itself, and no strict prefix of it is a frame.
#[test]
#[cfg_attr(kani, kani::proof)]
#[cfg_attr(kani, kani::unwind(26))]
fn proof_proto_frame() {
    bounded::<24>(|bytes: &[u8]| {
        if let Some((kind, body)) = decode_proto_frame(bytes) {
            #[cfg(kani)]
            kani::cover!(!body.is_empty(), "a frame with a body decodes");
            assert_eq!(body.len() + PROTO_HEADER_BYTES, bytes.len());
            assert_eq!(encode_proto_frame(kind, body), bytes);
            assert!(decode_proto_frame(&bytes[..bytes.len() - 1]).is_none());
        }
    });
}

/// A data handshake has exactly one spelling.
#[test]
#[cfg_attr(kani, kani::proof)]
#[cfg_attr(kani, kani::unwind(22))]
fn proof_data_handshake() {
    bounded::<20>(|bytes: &[u8]| {
        if let Some((kind, nonce)) = decode_data_handshake_frame(bytes) {
            #[cfg(kani)]
            kani::cover!(kind == DataHandshakeKind::Ack, "an ack decodes");
            assert_eq!(encode_data_handshake_frame(kind, &nonce), bytes);
        }
    });
}

/// An accepted input run holds exactly `count` valid records, nothing after
/// them, and re-encodes to its own bytes. Random engine only: Kani reached no
/// verdict at 24 or 13 bytes, its records' UTF-8 validation stubbed or not.
#[test]
fn proof_input_run() {
    bounded::<24>(|bytes: &[u8]| {
        if let Some((header, entries)) = parse_input_run(bytes) {
            let entries: Vec<_> = entries
                .map(|entry| {
                    assert!(input_record::decode(entry.payload).is_some());
                    (entry.payload, entry.shadow_modelled)
                })
                .collect();
            assert_eq!(entries.len(), usize::from(header.count));
            let encoded =
                encode_probed_input_run(header.base_seq, header.retransmit, header.probe, &entries);
            assert_eq!(&encoded[PROTO_HEADER_BYTES..], bytes);
        }
    });
}

/// The one spelling of `record`: what `build` writes for it, which is what the
/// browser's `encodeKeyRecordInto` writes too.
fn canonical_input_record(record: input_record::InputRecord<'_>) -> Vec<u8> {
    use input_record::{
        InputRecord, KeyEvent, KeyText, MouseAction, MouseButton, WheelDirection, build,
    };
    match record {
        InputRecord::Key(key) => {
            let mut implied = [0; 4];
            let produced = match key.text {
                KeyText::None => None,
                KeyText::Implied(c) => Some(&*c.encode_utf8(&mut implied)),
                KeyText::Explicit(text) => Some(text),
            };
            let event = match key.event {
                KeyEvent::Press => 0,
                KeyEvent::Repeat => 1,
                KeyEvent::Release => 2,
            };
            let spec = build::Key {
                event,
                key: key.key,
                mods: key.mods,
                shifted: key.shifted,
                base: key.base,
                text: None,
            };
            build::key_typing(spec, produced)
        }
        InputRecord::Text(text) => build::text(text),
        InputRecord::Paste(text) => build::paste(text),
        InputRecord::Mouse(mouse) => {
            let action = match mouse.action {
                MouseAction::Press => 0,
                MouseAction::Release => 1,
                MouseAction::Motion => 2,
            };
            let button = match mouse.button {
                MouseButton::Left => 0,
                MouseButton::Middle => 1,
                MouseButton::Right => 2,
                MouseButton::None => 3,
            };
            build::mouse(action, button, mouse.mods, mouse.column, mouse.row)
        }
        InputRecord::Wheel(wheel) => {
            let direction = match wheel.direction {
                WheelDirection::Up => 0,
                WheelDirection::Down => 1,
                WheelDirection::Left => 2,
                WheelDirection::Right => 3,
            };
            build::wheel(direction, wheel.mods, wheel.count, wheel.column, wheel.row)
        }
        InputRecord::Focus(focused) => build::focus(focused),
    }
}

/// Every accepted input record is the one spelling its encoders write, so no
/// two byte strings carry the same input.
fn assert_canonical(bytes: &[u8]) {
    if let Some(record) = input_record::decode(bytes) {
        assert_eq!(canonical_input_record(record), bytes, "{record:?}");
    }
}

/// Random records up to twelve bytes. Kani reached no verdict on this property
/// even at four bytes, the decoder and both encoders together, so it is not in
/// the Kani list; the enumeration below settles the shortest records.
#[test]
fn proof_input_record_canonical() {
    bounded::<12>(assert_canonical);
}

/// Every byte string of at most three bytes, which holds a key with its
/// extension byte: a proof by enumeration.
#[test]
fn proof_input_records_up_to_three_bytes() {
    let mut bytes = Vec::with_capacity(3);
    for len in 0..=3u32 {
        for value in 0..1u32 << (8 * len) {
            bytes.clear();
            bytes.extend_from_slice(&value.to_le_bytes()[..len as usize]);
            assert_canonical(&bytes);
        }
    }
}
