//! Conformance vectors for `input_encoder`: Kitty's reference encoder for every
//! flag combination, XTerm for `modifyOtherKeys` and the mouse encodings.

use super::*;
use crate::network::input_record::{self, build, build::Key};

const SHIFT: u8 = mods::SHIFT;
const ALT: u8 = mods::ALT;
const CTRL: u8 = mods::CTRL;
const SUPER: u8 = mods::SUPER;
const PRESS: u8 = 0;
const REPEAT: u8 = 1;
const RELEASE: u8 = 2;
const KP_5: u32 = 0xE03C;

fn kitty(flags: u8) -> TermMode {
    let mut mode = TermMode::empty();
    mode.set(TermMode::DISAMBIGUATE_ESC_CODES, flags & 1 != 0);
    mode.set(TermMode::REPORT_EVENT_TYPES, flags & 2 != 0);
    mode.set(TermMode::REPORT_ALTERNATE_KEYS, flags & 4 != 0);
    mode.set(TermMode::REPORT_ALL_KEYS_AS_ESC, flags & 8 != 0);
    mode.set(TermMode::REPORT_ASSOCIATED_TEXT, flags & 16 != 0);
    mode
}

fn encoded(record: &[u8], mode: TermMode) -> String {
    let decoded = input_record::decode(record).expect("test record is canonical");
    let mut out = Vec::new();
    encode(&decoded, mode, &mut out);
    String::from_utf8(out).expect("encodings are UTF-8")
}

fn char_key(c: char, mods: u8) -> Vec<u8> {
    build::key(Key {
        key: u32::from(c),
        mods,
        ..Key::default()
    })
}

fn shifted_key(c: char, shifted: char, mods: u8) -> Vec<u8> {
    build::key(Key {
        key: u32::from(c),
        mods,
        shifted: Some(u32::from(shifted)),
        ..Key::default()
    })
}

fn fkey(code: u32, mods: u8) -> Vec<u8> {
    build::functional(code, PRESS, mods)
}

fn keypad_5() -> Vec<u8> {
    build::key(Key {
        key: KP_5,
        text: Some("5"),
        ..Key::default()
    })
}

fn assert_cases(mode: TermMode, cases: &[(Vec<u8>, &str)]) {
    for (record, expected) in cases {
        assert_eq!(&encoded(record, mode), expected, "record {record:02x?}");
    }
}

#[test]
fn legacy_keys_match_kitty_and_xterm() {
    assert_cases(
        TermMode::empty(),
        &[
            (char_key('a', 0), "a"),
            (shifted_key('a', 'A', SHIFT), "A"),
            (char_key('a', CTRL), "\x01"),
            (char_key('a', ALT), "\x1ba"),
            (char_key('a', CTRL | ALT), "\x1b\x01"),
            (shifted_key('a', 'A', CTRL | SHIFT), "\x1b[97;6u"),
            (char_key(' ', CTRL), "\0"),
            (char_key('[', CTRL), "\x1b"),
            (char_key('/', CTRL), "\x1f"),
            (shifted_key('1', '!', ALT | SHIFT), "\x1b!"),
            (fkey(UP, 0), "\x1b[A"),
            (fkey(UP, SHIFT), "\x1b[1;2A"),
            (fkey(LEFT, CTRL), "\x1b[1;5D"),
            (fkey(DELETE, 0), "\x1b[3~"),
            (fkey(DELETE, CTRL), "\x1b[3;5~"),
            (fkey(F1, 0), "\x1bOP"),
            (fkey(F1, SHIFT), "\x1b[1;2P"),
            (fkey(F5, 0), "\x1b[15~"),
            (fkey(MENU, 0), "\x1b[29~"),
            (fkey(ENTER, 0), "\r"),
            (fkey(ENTER, ALT), "\x1b\r"),
            (fkey(TAB, SHIFT), "\x1b[Z"),
            (fkey(TAB, SHIFT | ALT), "\x1b\x1b[Z"),
            (fkey(BACKSPACE, 0), "\x7f"),
            (fkey(BACKSPACE, CTRL), "\x08"),
            (fkey(BACKSPACE, ALT), "\x1b\x7f"),
            (fkey(ESCAPE, 0), "\x1b"),
            (fkey(ESCAPE, ALT), "\x1b\x1b"),
            // ⌘ is Alt, and ⌘Backspace erases the line.
            (char_key('b', SUPER), "\x1bb"),
            (fkey(BACKSPACE, SUPER), "\x15"),
            // Lock state is invisible to legacy encodings.
            (
                build::key(Key {
                    key: u32::from('a'),
                    mods: mods::CAPS_LOCK,
                    text: Some("A"),
                    ..Key::default()
                }),
                "A",
            ),
            // Ctrl on a non-Latin layout means the US key at that position.
            (
                build::key(Key {
                    key: u32::from('с'),
                    mods: CTRL,
                    base: Some(u32::from('c')),
                    ..Key::default()
                }),
                "\x03",
            ),
            // Keypad keys fold onto the main keys.
            (keypad_5(), "5"),
            (fkey(KP_ENTER, 0), "\r"),
            (fkey(KP_UP, 0), "\x1b[A"),
            // Nothing reports a release, a bare modifier or a lock key.
            (build::functional(u32::from('a'), RELEASE, 0), ""),
            (fkey(LEFT_SHIFT, SHIFT), ""),
            (fkey(CAPS_LOCK, 0), ""),
        ],
    );
}

#[test]
fn application_cursor_mode_switches_unmodified_cursor_keys_to_ss3() {
    let mode = TermMode::APP_CURSOR;
    assert_eq!(encoded(&fkey(UP, 0), mode), "\x1bOA");
    assert_eq!(encoded(&fkey(HOME, 0), mode), "\x1bOH");
    assert_eq!(encoded(&fkey(END, 0), mode), "\x1bOF");
    assert_eq!(encoded(&fkey(UP, CTRL), mode), "\x1b[1;5A");
    assert_eq!(encoded(&fkey(UP, 0), mode | kitty(1)), "\x1b[A");
}

#[test]
fn disambiguate_reports_ambiguous_keys_and_leaves_text_alone() {
    assert_cases(
        kitty(1),
        &[
            (char_key('a', 0), "a"),
            (shifted_key('a', 'A', SHIFT), "A"),
            (fkey(ESCAPE, 0), "\x1b[27u"),
            (char_key('a', CTRL), "\x1b[97;5u"),
            (char_key('i', CTRL), "\x1b[105;5u"),
            (char_key('a', ALT), "\x1b[97;3u"),
            (char_key('a', SUPER), "\x1b[97;9u"),
            (fkey(ENTER, 0), "\r"),
            (fkey(ENTER, SHIFT), "\x1b[13;2u"),
            (fkey(TAB, 0), "\t"),
            (fkey(TAB, SHIFT), "\x1b[9;2u"),
            (fkey(BACKSPACE, CTRL), "\x1b[127;5u"),
            (fkey(UP, 0), "\x1b[A"),
            (fkey(UP, CTRL), "\x1b[1;5A"),
            (fkey(F1, 0), "\x1b[P"),
            (fkey(F3, 0), "\x1b[13~"),
            (fkey(KP_ENTER, 0), "\x1b[57414u"),
            (keypad_5(), "5"),
            (build::functional(u32::from('a'), RELEASE, 0), ""),
        ],
    );
}

#[test]
fn event_types_report_repeats_and_releases_but_not_enter_tab_backspace() {
    let mode = kitty(1 | 2);
    let release_a = build::key(Key {
        event: RELEASE,
        key: u32::from('a'),
        ..Key::default()
    });
    assert_eq!(encoded(&release_a, mode), "\x1b[97;1:3u");
    let repeat_a = build::key(Key {
        event: REPEAT,
        key: u32::from('a'),
        ..Key::default()
    });
    assert_eq!(encoded(&repeat_a, mode), "a");
    let repeat_ctrl_a = build::key(Key {
        event: REPEAT,
        key: u32::from('a'),
        mods: CTRL,
        ..Key::default()
    });
    assert_eq!(encoded(&repeat_ctrl_a, mode), "\x1b[97;5:2u");
    assert_eq!(encoded(&build::functional(ENTER, RELEASE, 0), mode), "");
    assert_eq!(encoded(&build::functional(TAB, RELEASE, 0), mode), "");
    assert_eq!(encoded(&build::functional(BACKSPACE, RELEASE, 0), mode), "");
    assert_eq!(
        encoded(&build::functional(ENTER, RELEASE, SHIFT), mode),
        "\x1b[13;2:3u"
    );
    assert_eq!(
        encoded(&build::functional(UP, RELEASE, 0), mode),
        "\x1b[1;1:3A"
    );
    assert_eq!(
        encoded(&build::functional(LEFT_SHIFT, PRESS, SHIFT), mode),
        ""
    );
}

#[test]
fn report_all_keys_encodes_text_keys_modifiers_and_enter() {
    let mode = kitty(1 | 2 | 8);
    assert_eq!(encoded(&char_key('a', 0), mode), "\x1b[97u");
    assert_eq!(encoded(&shifted_key('a', 'A', SHIFT), mode), "\x1b[97;2u");
    assert_eq!(encoded(&fkey(ENTER, 0), mode), "\x1b[13u");
    assert_eq!(
        encoded(&build::functional(ENTER, RELEASE, 0), mode),
        "\x1b[13;1:3u"
    );
    assert_eq!(encoded(&fkey(LEFT_SHIFT, SHIFT), mode), "\x1b[57441;2u");
    assert_eq!(
        encoded(&build::functional(LEFT_SHIFT, RELEASE, 0), mode),
        "\x1b[57441;1:3u"
    );
    assert_eq!(
        encoded(&fkey(CAPS_LOCK, mods::CAPS_LOCK), mode),
        "\x1b[57358;65u"
    );
    assert_eq!(encoded(&fkey(KP_ENTER, 0), mode), "\x1b[57414u");
    assert_eq!(encoded(&keypad_5(), mode), "\x1b[57404u");
}

#[test]
fn alternate_keys_and_associated_text() {
    let alternates = kitty(8 | 4);
    assert_eq!(
        encoded(&shifted_key('a', 'A', SHIFT), alternates),
        "\x1b[97:65;2u"
    );
    let cyrillic = build::key(Key {
        key: u32::from('с'),
        base: Some(u32::from('c')),
        ..Key::default()
    });
    assert_eq!(encoded(&cyrillic, alternates), "\x1b[1089::99u");
    // Shift is not held, so the shifted key is not reported.
    let unshifted = build::key(Key {
        key: u32::from('a'),
        shifted: Some(u32::from('A')),
        ..Key::default()
    });
    assert_eq!(encoded(&unshifted, alternates), "\x1b[97u");

    let text = kitty(8 | 16);
    assert_eq!(encoded(&char_key('a', 0), text), "\x1b[97;;97u");
    assert_eq!(
        encoded(&shifted_key('a', 'A', SHIFT), text),
        "\x1b[97;2;65u"
    );
    assert_eq!(encoded(&char_key('a', CTRL), text), "\x1b[97;5u");
    let release = build::key(Key {
        event: RELEASE,
        key: u32::from('a'),
        ..Key::default()
    });
    assert_eq!(encoded(&release, kitty(8 | 16 | 2)), "\x1b[97;1:3u");
}

#[test]
fn modify_other_keys_reports_only_what_each_level_claims() {
    let one = TermMode::MODIFY_OTHER_KEYS_1;
    assert_eq!(encoded(&char_key('a', CTRL), one), "\x01");
    assert_eq!(encoded(&char_key('a', ALT), one), "\x1b[27;3;97~");
    assert_eq!(encoded(&char_key('2', CTRL), one), "\0");
    assert_eq!(encoded(&char_key('1', CTRL), one), "\x1b[27;5;49~");
    assert_eq!(
        encoded(&shifted_key('1', '!', CTRL | SHIFT), one),
        "\x1b[27;6;33~"
    );
    assert_eq!(encoded(&shifted_key('a', 'A', SHIFT), one), "A");
    assert_eq!(encoded(&fkey(ENTER, SHIFT), one), "\x1b[27;2;13~");
    assert_eq!(encoded(&fkey(BACKSPACE, ALT), one), "\x1b\x7f");
    assert_eq!(encoded(&fkey(UP, CTRL), one), "\x1b[1;5A");

    let two = TermMode::MODIFY_OTHER_KEYS_2;
    assert_eq!(encoded(&char_key('a', CTRL), two), "\x1b[27;5;97~");
    assert_eq!(
        encoded(&shifted_key('a', 'A', CTRL | SHIFT), two),
        "\x1b[27;6;65~"
    );
    // A Shift that produces text is text before any reporting is considered.
    assert_eq!(encoded(&shifted_key('a', 'A', SHIFT), two), "A");
    assert_eq!(encoded(&shifted_key('1', '!', SHIFT), two), "!");
    assert_eq!(encoded(&fkey(BACKSPACE, CTRL), two), "\x08");
    assert_eq!(encoded(&fkey(ESCAPE, CTRL), two), "\x1b[27;5;27~");
    // Kitty flags outrank modifyOtherKeys.
    assert_eq!(encoded(&char_key('a', CTRL), two | kitty(1)), "\x1b[97;5u");
}

#[test]
fn mouse_reports_follow_the_enabled_encoding() {
    let sgr = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
    assert_eq!(encoded(&build::mouse(0, 0, 0, 0, 0), sgr), "\x1b[<0;1;1M");
    assert_eq!(encoded(&build::mouse(1, 2, 0, 4, 9), sgr), "\x1b[<2;5;10m");
    assert_eq!(
        encoded(&build::mouse(0, 0, CTRL | SHIFT, 0, 0), sgr),
        "\x1b[<20;1;1M"
    );
    // Motion needs drag tracking with a button held, or any-motion tracking.
    assert_eq!(encoded(&build::mouse(2, 0, 0, 1, 1), sgr), "");
    assert_eq!(
        encoded(&build::mouse(2, 0, 0, 1, 1), sgr | TermMode::MOUSE_DRAG),
        "\x1b[<32;2;2M"
    );
    assert_eq!(
        encoded(&build::mouse(2, 3, 0, 1, 1), sgr | TermMode::MOUSE_DRAG),
        ""
    );
    assert_eq!(
        encoded(&build::mouse(2, 3, 0, 1, 1), sgr | TermMode::MOUSE_MOTION),
        "\x1b[<35;2;2M"
    );

    let x10 = TermMode::MOUSE_REPORT_CLICK;
    assert_eq!(
        encoded(&build::mouse(0, 0, 0, 1, 2), x10),
        "\x1b[M\x20\x22\x23"
    );
    assert_eq!(
        encoded(&build::mouse(1, 0, 0, 1, 2), x10),
        "\x1b[M\x23\x22\x23"
    );
    assert_eq!(encoded(&build::mouse(0, 0, 0, 300, 2), x10), "");

    let utf8 = x10 | TermMode::UTF8_MOUSE;
    assert_eq!(
        encoded(&build::mouse(0, 0, 0, 300, 2), utf8),
        "\x1b[M\x20\u{14d}\x23"
    );
    assert_eq!(encoded(&build::mouse(0, 0, 0, 3000, 2), utf8), "");

    assert_eq!(encoded(&build::mouse(0, 0, 0, 0, 0), TermMode::empty()), "");
}

#[test]
fn wheel_reports_buttons_or_scrolls_the_alternate_screen() {
    let sgr = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
    assert_eq!(
        encoded(&build::wheel(0, 0, 2, 3, 4), sgr),
        "\x1b[<64;4;5M\x1b[<64;4;5M"
    );
    assert_eq!(
        encoded(&build::wheel(1, CTRL, 1, 0, 0), sgr),
        "\x1b[<81;1;1M"
    );

    let alternate = TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL;
    assert_eq!(
        encoded(&build::wheel(0, 0, 2, 0, 0), alternate),
        "\x1b[A\x1b[A"
    );
    assert_eq!(
        encoded(
            &build::wheel(1, 0, 1, 0, 0),
            alternate | TermMode::APP_CURSOR
        ),
        "\x1bOB"
    );
    assert_eq!(encoded(&build::wheel(2, 0, 1, 0, 0), alternate), "");
    assert_eq!(
        encoded(&build::wheel(0, 0, 1, 0, 0), TermMode::ALT_SCREEN),
        ""
    );
}

#[test]
fn paste_is_bracketed_without_escapes_only_when_asked() {
    let paste = build::paste("rm -rf /\x1b[201~\necho");
    assert_eq!(
        encoded(&paste, TermMode::empty()),
        "rm -rf /\x1b[201~\necho"
    );
    assert_eq!(
        encoded(&paste, TermMode::BRACKETED_PASTE),
        "\x1b[200~rm -rf /[201~\necho\x1b[201~"
    );
}

/// Every ESC is dropped and every other byte kept, in order, wherever the ESC
/// falls: at either end, in runs, beside multi-byte UTF-8, and on each side of
/// the vector search's block boundaries.
#[test]
fn bracketed_paste_drops_exactly_its_escapes() {
    let mut texts: Vec<String> = [
        "\x1b",
        "\x1b\x1b\x1b",
        "\x1ba\x1b",
        "a\x1b\x1bb",
        "終\x1b端\x1b🚀",
    ]
    .map(str::to_owned)
    .to_vec();
    for len in [15, 16, 17, 31, 32, 33, 63, 64, 65, 8 * 1024] {
        for every in [1, 2, 8, 31, 512] {
            texts.push(
                (0..len)
                    .map(|index| {
                        if index % every == every - 1 {
                            '\x1b'
                        } else {
                            char::from(b'a' + (index % 26) as u8)
                        }
                    })
                    .collect(),
            );
        }
    }
    for text in &texts {
        assert_eq!(
            encoded(&build::paste(text), TermMode::BRACKETED_PASTE),
            format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', "")),
            "{text:?}"
        );
    }
}

#[test]
fn committed_text_sends_enter_as_carriage_return() {
    assert_eq!(
        encoded(&build::text("ab\ncd\n"), TermMode::empty()),
        "ab\rcd\r"
    );
}

#[test]
fn focus_is_reported_only_when_the_application_asked() {
    assert_eq!(
        encoded(&build::focus(true), TermMode::FOCUS_IN_OUT),
        "\x1b[I"
    );
    assert_eq!(
        encoded(&build::focus(false), TermMode::FOCUS_IN_OUT),
        "\x1b[O"
    );
    assert_eq!(encoded(&build::focus(true), TermMode::empty()), "");
}

#[test]
fn encoded_bytes_never_exceed_the_payload_hint_for_bounded_records() {
    let worst_key = build::key(Key {
        event: RELEASE,
        key: 0x10FFFF,
        mods: 0xff,
        shifted: Some(0x10FFFE),
        base: Some(0x10FFFD),
        ..Key::default()
    });
    let decoded = input_record::decode(&worst_key).expect("canonical");
    let mut out = Vec::new();
    encode(&decoded, kitty(31), &mut out);
    // A key is bounded by its fields, never by its text.
    assert!(out.len() <= 48, "{}", out.len());
}

/// Text is hinted at exactly its encoded length, so a commit that fits the
/// inline PTY payload (an IME phrase, a predicted word) is encoded where it is
/// queued without reaching the allocator.
#[test]
fn committed_text_is_hinted_exactly_and_an_inline_sized_commit_never_allocates() {
    for text in [
        "a",
        "\n",
        "ab\ncd\n",
        "終端\nターミナル",
        "🚀🚀🚀🚀🚀🚀",
        &"\n".repeat(23),
        &"x".repeat(4096),
    ] {
        let record = build::text(text);
        assert_eq!(
            encoded_len_hint(&record),
            encoded(&record, TermMode::empty()).len(),
            "{text:?}"
        );
    }

    // 23 bytes, the most the inline payload holds.
    let record = build::text("ab終端ターミナル");
    assert_eq!(encoded_len_hint(&record), 23);
    let decoded = input_record::decode(&record).expect("canonical");
    crate::edge_tunnel::test_allocations::begin_thread();
    let mut payload = crate::pty::PtyWritePayload::with_capacity(encoded_len_hint(&record));
    encode(&decoded, TermMode::empty(), &mut payload);
    let tally = crate::edge_tunnel::test_allocations::end_thread();
    assert!(!payload.is_empty());
    assert_eq!(
        tally.allocations, 0,
        "an inline-sized commit allocated {} bytes",
        tally.allocated_bytes
    );
}
