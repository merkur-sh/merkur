use super::*;

fn device() -> Device {
    serde_json::from_str(r#"{"id":"machine","userId":"user","name":"café","platform":"macOS","lastSeen":null,"status":"online","version":null,"identitySealBackend":"hardware"}"#).unwrap()
}
fn snapshot(seq: u64) -> Event {
    Event::Snapshot(Snapshot {
        epoch: "ab12".into(),
        seq,
        devices: vec![device()],
    })
}

#[test]
fn every_byte_split_preserves_utf8_multiline_data_and_crlf() {
    let device = serde_json::to_string(&device()).unwrap();
    let wire = format!(
        "\u{feff}: padding\r\nevent: snapshot\r\ndata: {{\"epoch\":\"ab12\",\"seq\":3,\r\ndata: \"devices\":[{device}]}}\r\n\r\nevent: delta\ndata: {{\"kind\":\"rename\",\"seq\":4,\"deviceId\":\"machine\",\"name\":\"renamed\"}}\n\n"
    );
    for split in 0..=wire.len() {
        let mut parser = Parser::default();
        parser.feed(&wire.as_bytes()[..split]).unwrap();
        parser.feed(&wire.as_bytes()[split..]).unwrap();
        let mut list = List::default();
        assert!(list.apply(parser.ready.pop_front().unwrap()).unwrap());
        assert_eq!(list.devices[0].name, "café");
        assert!(list.apply(parser.ready.pop_front().unwrap()).unwrap());
        assert_eq!(list.devices[0].name, "renamed");
        assert_eq!(list.cursor.unwrap().seq, 4);
        assert!(parser.ready.is_empty());
    }
    let mut parser = Parser::default();
    for byte in wire.as_bytes() {
        parser.feed(&[*byte]).unwrap();
    }
    assert_eq!(parser.ready.len(), 2);
}

#[test]
fn resume_requires_the_exact_retained_list_and_gaps_never_change_it() {
    let mut list = List::default();
    assert!(
        list.apply(Event::Resume(Cursor {
            epoch: "ab12".into(),
            seq: 3
        }))
        .is_err()
    );
    list.apply(snapshot(3)).unwrap();
    assert!(
        !list
            .apply(Event::Resume(Cursor {
                epoch: "ab12".into(),
                seq: 3
            }))
            .unwrap()
    );
    assert!(
        list.apply(Event::Resume(Cursor {
            epoch: "ff".into(),
            seq: 3
        }))
        .is_err()
    );
    let rename = |seq| {
        Event::Delta(Delta::Rename {
            seq,
            device_id: "machine".into(),
            name: "changed".into(),
        })
    };
    assert!(list.apply(rename(5)).is_err());
    assert_eq!(list.cursor.as_ref().unwrap().seq, 3);
    assert_eq!(list.devices[0].name, "café");
    assert!(!list.apply(rename(3)).unwrap());
    assert!(list.apply(rename(4)).unwrap());
    assert!(!list.apply(rename(4)).unwrap());
}

#[test]
fn absolute_deltas_never_invent_an_unknown_machine() {
    let mut list = List::default();
    list.apply(snapshot(0)).unwrap();
    assert!(
        !list
            .apply(Event::Delta(Delta::Presence {
                seq: 1,
                daemon_id: "unknown".into(),
                status: Status::Offline
            }))
            .unwrap()
    );
    assert_eq!(list.devices.len(), 1);
    assert_eq!(list.cursor.as_ref().unwrap().seq, 1);
    assert!(
        list.apply(Event::Delta(Delta::Presence {
            seq: 2,
            daemon_id: "machine".into(),
            status: Status::Degraded
        }))
        .unwrap()
    );
    assert_eq!(list.devices[0].status, Status::Degraded);
    assert!(
        list.apply(Event::Delta(Delta::Remove {
            seq: 3,
            device_id: "machine".into()
        }))
        .unwrap()
    );
    assert!(list.devices.is_empty());
    assert!(
        list.apply(Event::Delta(Delta::Added {
            seq: 4,
            device: device()
        }))
        .unwrap()
    );
    assert_eq!(list.devices.len(), 1);
}

#[test]
fn mandatory_nullable_fields_unknown_fields_and_unsafe_sequences_are_refused() {
    let mut value = serde_json::to_value(device()).unwrap();
    value.as_object_mut().unwrap().remove("version");
    assert!(serde_json::from_value::<Device>(value).is_err());
    let mut parser = Parser::default();
    assert!(parser.feed(b"event: delta\ndata: {\"kind\":\"remove\",\"seq\":1,\"deviceId\":\"machine\",\"extra\":true}\n\n").is_err());
    let mut list = List::default();
    assert!(list.apply(snapshot(MAX_SEQUENCE + 1)).is_err());
    assert!(list.cursor.is_none());
    assert!(
        list.apply(Event::Snapshot(Snapshot {
            epoch: "AB".into(),
            seq: 0,
            devices: vec![device()]
        }))
        .is_err()
    );
}

#[test]
fn session_end_is_explicit_and_presence_ids_are_unique() {
    let mut parser = Parser::default();
    parser
        .feed(b": keep-alive\n\nevent: browser-session-ended\ndata: null\n\n")
        .unwrap();
    assert!(matches!(
        parser.ready.pop_front(),
        Some(Event::SessionEnded)
    ));
    assert!(parse_event("browser-session-ended", b"{}").is_err());
    assert!(parse_event("browser-presence", br#"{"activeDelegationIds":["a","a"]}"#).is_err());
    assert!(
        matches!(parse_event("browser-presence", br#"{"activeDelegationIds":["a","b"]}"#).unwrap(), Some(Event::Presence(ids)) if ids == ["a", "b"])
    );
}
