//! The host's reports as Ghostty and Kitty send them under flags 31, SGR mouse,
//! bracketed paste and focus reporting.

use merkur_wire::input_record::build::{self, Key};
use merkur_wire::input_record::{InputRecord, decode, mods};

use super::*;

fn parse(bytes: &[u8]) -> Vec<HostEvent> {
    let mut input = HostInput::default();
    let mut out = Vec::new();
    input.feed(bytes, &mut out);
    out
}

fn record(bytes: &[u8]) -> Vec<u8> {
    match &parse(bytes)[..] {
        [HostEvent::Record(record)] => record.clone(),
        other => panic!("one record from {bytes:?}, got {other:?}"),
    }
}

fn key(event: u8, key: u32, key_mods: u8, shifted: Option<char>, base: Option<char>) -> Vec<u8> {
    build::key(Key {
        event,
        key,
        mods: key_mods,
        shifted: shifted.map(u32::from),
        base: base.map(u32::from),
        text: None,
    })
}

fn text_of(record: &[u8]) -> String {
    match decode(record) {
        Some(InputRecord::Key(key)) => format!("{:?}", key.text),
        other => panic!("a key record, got {other:?}"),
    }
}

const A: u32 = 'a' as u32;

#[test]
fn a_typed_letter_is_the_record_the_browser_sends_for_it() {
    assert_eq!(record(b"\x1b[97;;97u"), build::press('a'));
    assert_eq!(record(b"\x1b[97;1:2;97u"), key(1, A, 0, None, None));
    assert_eq!(record(b"\x1b[97;1:3u"), key(2, A, 0, None, None));
    // Shift names the shifted key, whose text stays implied.
    assert_eq!(
        record(b"\x1b[97:65;2;65u"),
        key(0, A, mods::SHIFT, Some('A'), None)
    );
    // Ctrl types nothing; a Cyrillic key names its PC-101 position too.
    assert_eq!(
        record(b"\x1b[99;5u"),
        key(0, 'c' as u32, mods::CTRL, None, None)
    );
    assert_eq!(
        record(b"\x1b[1089::99;5u"),
        key(0, 1089, mods::CTRL, None, Some('c'))
    );
    // Caps Lock's capital is stated; a key that typed nothing says so.
    assert_eq!(text_of(&record(b"\x1b[97;65;65u")), "Explicit(\"A\")");
    assert_eq!(text_of(&record(b"\x1b[97u")), "None");
}

#[test]
fn legacy_spellings_name_their_functional_keys() {
    let cases: &[(&[u8], u8, u32, u8)] = &[
        (b"\x1b[13u", 0, functional::ENTER, 0),
        (b"\x1b[9;2u", 0, functional::TAB, mods::SHIFT),
        (b"\x1b[127u", 0, functional::BACKSPACE, 0),
        (b"\x1b[27u", 0, functional::ESCAPE, 0),
        (b"\x1b[A", 0, functional::UP, 0),
        (b"\x1b[1;5D", 0, functional::LEFT, mods::CTRL),
        (b"\x1b[1;1:3C", 2, functional::RIGHT, 0),
        (b"\x1b[H", 0, functional::HOME, 0),
        (b"\x1b[P", 0, functional::F1, 0),
        (b"\x1b[13~", 0, functional::F1 + 2, 0),
        (b"\x1b[15~", 0, functional::F1 + 4, 0),
        (b"\x1b[24~", 0, functional::F1 + 11, 0),
        (b"\x1b[3;2~", 0, functional::DELETE, mods::SHIFT),
        (b"\x1b[6;1:2~", 1, functional::PAGE_DOWN, 0),
        // The keypad and the modifier keys are Kitty's own numbers.
        (b"\x1b[57399u", 0, FUNCTIONAL_KEY_FIRST + 55, 0),
        (b"\x1b[57441;2u", 0, FUNCTIONAL_KEY_FIRST + 97, mods::SHIFT),
    ];
    for (bytes, event, code, key_mods) in cases {
        assert_eq!(
            record(bytes),
            key(*event, *code, *key_mods, None, None),
            "{bytes:?}"
        );
    }
}

#[test]
fn raw_terminal_keys_name_the_same_keys_as_extended_reports() {
    let cases: &[(&[u8], u32, u8)] = &[
        (b"\r", functional::ENTER, 0),
        (b"\t", functional::TAB, 0),
        (b"\x08", functional::BACKSPACE, 0),
        (b"\x7f", functional::BACKSPACE, 0),
        (b"\x1b[3~", functional::DELETE, 0),
        (b"\x00", ' ' as u32, mods::CTRL),
        (b"\x01", 'a' as u32, mods::CTRL),
        (b"\x02", 'b' as u32, mods::CTRL),
        (b"\x03", 'c' as u32, mods::CTRL),
        (b"\n", 'j' as u32, mods::CTRL),
        (b"\x1a", 'z' as u32, mods::CTRL),
        (b"\x1c", '\\' as u32, mods::CTRL),
        (b"\x1d", ']' as u32, mods::CTRL),
        (b"\x1e", '^' as u32, mods::CTRL),
        (b"\x1f", '_' as u32, mods::CTRL),
    ];
    for (bytes, code, key_mods) in cases {
        assert_eq!(
            record(bytes),
            key(0, *code, *key_mods, None, None),
            "{bytes:?}"
        );
    }
}

#[test]
fn raw_keys_preserve_text_order_across_every_read_boundary() {
    let bytes = "hé\u{7f}llo\r\u{2}n\u{1c}\u{1c}\u{8}\u{9}\x1b[3~".as_bytes();
    let expected = vec![
        HostEvent::Record(build::text("hé")),
        HostEvent::Record(key(0, functional::BACKSPACE, 0, None, None)),
        HostEvent::Record(build::text("llo")),
        HostEvent::Record(key(0, functional::ENTER, 0, None, None)),
        HostEvent::Record(key(0, 'b' as u32, mods::CTRL, None, None)),
        HostEvent::Record(build::text("n")),
        HostEvent::Record(key(0, '\\' as u32, mods::CTRL, None, None)),
        HostEvent::Record(key(0, '\\' as u32, mods::CTRL, None, None)),
        HostEvent::Record(key(0, functional::BACKSPACE, 0, None, None)),
        HostEvent::Record(key(0, functional::TAB, 0, None, None)),
        HostEvent::Record(key(0, functional::DELETE, 0, None, None)),
    ];
    assert_eq!(parse(bytes), expected);
    for split in 0..=bytes.len() {
        let mut input = HostInput::default();
        let mut out = Vec::new();
        input.feed(&bytes[..split], &mut out);
        input.feed(&bytes[split..], &mut out);
        // A read may split a text run into multiple records. Its keys must
        // remain in order and its committed text must concatenate identically.
        let flatten = |events: &[HostEvent]| {
            let mut records = Vec::new();
            for event in events {
                let HostEvent::Record(record) = event else {
                    panic!("unexpected host reply");
                };
                match decode(record) {
                    Some(InputRecord::Text(text)) => {
                        records.extend(text.chars().map(|c| build::text(&c.to_string())));
                    }
                    _ => records.push(record.clone()),
                }
            }
            records
        };
        assert_eq!(flatten(&out), flatten(&expected), "split {split}");
        assert!(input.pending.is_empty());
    }
}

#[test]
fn committed_text_paste_and_focus_are_their_own_records() {
    assert_eq!(record("héllo".as_bytes()), build::text("héllo"));
    assert_eq!(
        parse(b"a\x01b"),
        [
            HostEvent::Record(build::text("a")),
            HostEvent::Record(key(0, 'a' as u32, mods::CTRL, None, None)),
            HostEvent::Record(build::text("b")),
        ]
    );
    assert_eq!(record(b"\x1b[0;;104:105u"), build::text("hi"));
    assert_eq!(
        record(b"\x1b[200~a\r\n\x1b[1mb\x1b[201~"),
        build::paste("a\r\n\x1b[1mb")
    );
    assert_eq!(record(b"\x1b[I"), build::focus(true));
    assert_eq!(record(b"\x1b[O"), build::focus(false));
}

#[test]
fn mouse_reports_are_zero_based_cells_with_their_modifiers() {
    let mouse = |action, button, record_mods, column, row| {
        HostEvent::Mouse(MouseRecord {
            action,
            button,
            mods: record_mods,
            column,
            row,
        })
    };
    assert_eq!(
        parse(b"\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<35;3;4M\x1b[<20;1;1M"),
        [
            mouse(MouseAction::Press, MouseButton::Left, 0, 9, 4),
            mouse(MouseAction::Release, MouseButton::Left, 0, 9, 4),
            mouse(MouseAction::Motion, MouseButton::None, 0, 2, 3),
            mouse(
                MouseAction::Press,
                MouseButton::Left,
                mods::SHIFT | mods::CTRL,
                0,
                0
            ),
        ]
    );
    assert_eq!(
        parse(b"\x1b[<65;2;2M\x1b[<72;1;1M"),
        [
            HostEvent::Wheel(WheelRecord {
                direction: WheelDirection::Down,
                mods: 0,
                count: 1,
                column: 1,
                row: 1,
            }),
            HostEvent::Wheel(WheelRecord {
                direction: WheelDirection::Up,
                mods: mods::ALT,
                count: 1,
                column: 0,
                row: 0,
            }),
        ]
    );
    // A back button, and a release with no button, have no record.
    assert!(parse(b"\x1b[<128;1;1M\x1b[<3;1;1m").is_empty());
}

#[test]
fn replies_are_routed_apart_from_input() {
    assert_eq!(
        parse(b"\x1b[0n\x1b[?31u\x1b[?2026;2$y\x1b[?62;22c"),
        [
            HostEvent::Reply(Reply::Consumed),
            HostEvent::Reply(Reply::KeyboardFlags(31)),
            HostEvent::Reply(Reply::Mode {
                mode: 2026,
                value: 2
            }),
            HostEvent::Reply(Reply::DeviceAttributes),
        ]
    );
    assert_eq!(
        parse(b"\x1b]11;rgb:0/0/0\x07\x1b_Gi=1;OK\x1b\\\x1bP>|ghostty\x1b\\"),
        [
            HostEvent::Reply(Reply::Osc(b"11;rgb:0/0/0".to_vec())),
            HostEvent::Reply(Reply::Graphics {
                image: 1,
                placement: None,
                result: Ok(())
            }),
            HostEvent::Reply(Reply::Dcs(b">|ghostty".to_vec())),
        ]
    );
    // A cursor report and a key with a field too many are dropped whole.
    assert!(parse(b"\x1b[12;40R\x1b[97;1;97;1u").is_empty());
}

#[test]
fn a_token_split_across_reads_arrives_once_it_is_whole() {
    let stream = "\x1b[97:65;2;65ué\x1b[200~x\x1b[201~\x1b]0;t\x1b\\".as_bytes();
    let whole = parse(stream);
    assert_eq!(whole.len(), 4);
    let mut input = HostInput::default();
    let mut out = Vec::new();
    for byte in stream {
        input.feed(std::slice::from_ref(byte), &mut out);
    }
    assert_eq!(out, whole);
    assert!(input.pending.is_empty());
}

#[test]
fn every_record_the_parser_makes_is_canonical() {
    for bytes in [
        &b"\x1b[97;;97u"[..],
        b"\x1b[1089::99;5u",
        b"\x1b[97;65;65u",
        b"\x1b[57441;2u",
        b"\x1b[1;1:3C",
    ] {
        assert!(validate(&record(bytes)), "{bytes:?}");
    }
}

#[test]
fn pixel_cell_replies_do_not_discard_split_secret_input() {
    let mut parser = HostInput::default();
    let mut events = Vec::new();
    parser.feed(b"\x1b[6;20;10t\xc3", &mut events);
    assert_eq!(
        events,
        [HostEvent::Reply(Reply::CellSize {
            width: 10,
            height: 20
        })]
    );
    parser.clear_typed();
    events.clear();
    parser.feed(b"\xa9", &mut events);
    assert_eq!(events, [HostEvent::Record(build::text("é"))]);
    parser.clear_sensitive();
    assert!(parser.pending.is_empty());
    assert!(parser.typed.is_empty());
    assert!(parse(b"\x1b[6;0;10t\x1b[6;20;10;3t").is_empty());
}

#[test]
fn graphics_replies_are_typed_across_every_read_boundary() {
    let bytes = b"\x1b_Gi=13,p=7;ENOENT:evicted\x1b\\";
    for split in 0..=bytes.len() {
        let mut input = HostInput::default();
        let mut events = Vec::new();
        input.feed(&bytes[..split], &mut events);
        input.feed(&bytes[split..], &mut events);
        assert_eq!(
            events,
            vec![HostEvent::Reply(Reply::Graphics {
                image: 13,
                placement: Some(7),
                result: Err("ENOENT:evicted".into()),
            })]
        );
    }
    for body in [
        "Gi=0;OK",
        "Gi=1,i=2;OK",
        "Gi=1,p=0;OK",
        "Gi=+1;OK",
        "Gi=1;",
        "Gi=1;OK\n",
        "Gi=1,x=2;OK",
    ] {
        let bytes = format!("\x1b_{body}\x1b\\");
        assert_eq!(
            parse(bytes.as_bytes()),
            vec![HostEvent::Reply(Reply::Apc(body.as_bytes().to_vec()))]
        );
    }
}

#[test]
fn consumed_input_is_wiped_without_losing_the_incomplete_next_key() {
    let mut parser = HostInput::default();
    let mut events = Vec::new();
    let bytes = b"password-prefix\x1b[97;1;97:98";
    parser.feed(bytes, &mut events);
    assert_eq!(&parser.pending, b"\x1b[97;1;97:98");
    // SAFETY: `pending` held all of `bytes` before it was truncated, so its
    // allocation is at least `bytes.len()` long and `len()` is inside it.
    let tail = unsafe { parser.pending.as_ptr().add(parser.pending.len()) };
    // SAFETY: all these bytes were initialized by feed. The live allocation
    // remains owned by pending; its consumed tail was wiped before truncation.
    let former_tail =
        unsafe { std::slice::from_raw_parts(tail, bytes.len() - parser.pending.len()) };
    assert!(former_tail.iter().all(|byte| *byte == 0));
    parser.feed(b"u", &mut events);
    assert!(parser.pending.is_empty());
    assert!(parser.typed.is_empty());
    let record = match events.last() {
        Some(HostEvent::Record(record)) => record,
        _ => panic!("missing completed key"),
    };
    assert!(
        matches!(merkur_wire::input_record::decode(record), Some(merkur_wire::input_record::InputRecord::Key(key)) if key.text == merkur_wire::input_record::KeyText::Explicit("ab"))
    );
    // SAFETY: zeroize initialized the full typed allocation while it remains live.
    let typed =
        unsafe { std::slice::from_raw_parts(parser.typed.as_ptr(), parser.typed.capacity()) };
    assert!(typed.iter().all(|byte| *byte == 0));
}

#[test]
fn split_password_paste_keeps_only_the_unfinished_marker_then_wipes_storage() {
    let mut parser = HostInput::default();
    let mut events = Vec::new();
    parser.feed(b"\x1b[200~private-prefix", &mut events);
    parser.feed(b"-continued-secret\x1b[20", &mut events);
    assert_eq!(&parser.pending, b"\x1b[20");
    parser.feed(b"1~", &mut events);
    assert!(parser.pending.is_empty());
    assert!(parser.paste.is_none());
    assert!(
        matches!(events.first(), Some(HostEvent::Record(record)) if matches!(merkur_wire::input_record::decode(record), Some(merkur_wire::input_record::InputRecord::Paste("private-prefix-continued-secret"))))
    );
}
