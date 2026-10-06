//! The pure rules against `input-controller.test.ts`,
//! `prediction-gate.test.ts` and `prediction-input-barrier.test.ts`. The
//! model itself runs against term-wasm in `merkur-client-native`'s grid
//! tests.

use merkur_wire::input_record::{InputRecord, build, decode, keys, mods};

use super::*;

fn key_intent(record: &[u8], granted: bool) -> PredictionCommand {
    let Some(InputRecord::Key(key)) = decode(record) else {
        panic!("a key record");
    };
    intent(&key, granted)
}

#[test]
fn a_printable_is_predictable_exactly_when_the_grid_gives_it_one_cell() {
    for one_cell in ['a', ' ', '~', 'é', 'ß', 'Ж', '→', '─'] {
        assert!(predictable_width_one(u32::from(one_cell)), "{one_cell:?}");
    }
    // Wide emoji inside the old hand-written range, CJK, a combining mark, a
    // zero-width space and controls: none of them is one cell.
    for not_one_cell in [
        '⌚', '⏩', '中', '\u{301}', '\u{200b}', '\u{7f}', '\u{85}', '\t',
    ] {
        assert!(
            !predictable_width_one(u32::from(not_one_cell)),
            "{not_one_cell:?}"
        );
    }
    assert!(!predictable_width_one(0xd800));
    assert!(!predictable_width_one(0x11_0000));
}

fn with(key: u32, key_mods: u8, shifted: Option<u32>) -> Vec<u8> {
    build::key(build::Key {
        key,
        mods: key_mods,
        shifted,
        ..build::Key::default()
    })
}

#[test]
fn a_printable_under_at_most_shift_is_predicted_and_lock_state_is_ignored() {
    assert_eq!(
        key_intent(&build::press('a'), true),
        PredictionCommand::Printable(0x61)
    );
    assert_eq!(
        key_intent(&build::press(' '), true),
        PredictionCommand::Printable(0x20)
    );
    assert_eq!(
        key_intent(&with(0x61, mods::SHIFT, Some(0x41)), true),
        PredictionCommand::Printable(0x41)
    );
    assert_eq!(
        key_intent(&with(0x61, mods::CAPS_LOCK | mods::NUM_LOCK, None), true),
        PredictionCommand::Printable(0x61)
    );
    assert_eq!(
        key_intent(&with(0x61, mods::CTRL, None), true),
        PredictionCommand::Flush
    );
    assert_eq!(
        key_intent(&with(0x61, mods::ALT, None), true),
        PredictionCommand::Flush
    );
}

#[test]
fn only_the_bare_editing_keys_are_modelled() {
    let functional = |code, key_mods| build::functional(code, 0, key_mods);
    assert_eq!(
        key_intent(&functional(keys::BACKSPACE, 0), true),
        PredictionCommand::Backspace
    );
    assert_eq!(
        key_intent(&functional(keys::DELETE, 0), true),
        PredictionCommand::Delete
    );
    assert_eq!(
        key_intent(&functional(keys::LEFT, 0), true),
        PredictionCommand::CursorShift(-1)
    );
    assert_eq!(
        key_intent(&functional(keys::RIGHT, mods::CAPS_LOCK), true),
        PredictionCommand::CursorShift(1)
    );
    // A chord, and every key whose result only the shell knows: Enter, Tab,
    // history.
    assert_eq!(
        key_intent(&functional(keys::LEFT, mods::SHIFT), true),
        PredictionCommand::Flush
    );
    for enter_tab_up in [0xE001, 0xE002, 0xE008] {
        assert_eq!(
            key_intent(&functional(enter_tab_up, 0), true),
            PredictionCommand::Flush
        );
    }
}

#[test]
fn nothing_is_modelled_without_the_daemons_grant() {
    assert_eq!(
        key_intent(&build::press('a'), false),
        PredictionCommand::Flush
    );
    assert_eq!(
        key_intent(&build::functional(keys::BACKSPACE, 0, 0), false),
        PredictionCommand::Flush
    );
}

#[test]
fn only_a_single_width_one_code_point_is_predictable() {
    let text = |text| {
        build::key(build::Key {
            key: 0x61,
            text: Some(text),
            ..build::Key::default()
        })
    };
    assert_eq!(
        key_intent(&text("é"), true),
        PredictionCommand::Printable(0xe9)
    );
    assert_eq!(key_intent(&text("ab"), true), PredictionCommand::Flush);
    // A combining mark advances no cell; a Hangul jamo and a wide character
    // advance two.
    assert_eq!(key_intent(&text("\u{301}"), true), PredictionCommand::Flush);
    assert_eq!(
        key_intent(&text("\u{1100}"), true),
        PredictionCommand::Flush
    );
    assert_eq!(key_intent(&text("語"), true), PredictionCommand::Flush);
    assert!(predictable_width_one(0x7e));
    assert!(!predictable_width_one(0x7f));
    assert!(!predictable_width_one(0x9f));
    // The grid's table, not a code point range: a narrow arrow past the old
    // hand-written bound is one cell, the wide square beside it two.
    assert!(predictable_width_one(0x2b00));
    assert!(!predictable_width_one(0x2b1b));
}

#[test]
fn display_covers_an_input_at_or_past_it_in_serial_order() {
    assert!(covered(3, 5));
    assert!(covered(5, 5));
    assert!(!covered(6, 5));
    assert!(!covered(1, 0));
    assert!(!covered(0, 5));
    assert!(covered(u32::MAX, 1));
    assert!(!covered(1, u32::MAX));
}

#[test]
fn the_barrier_extends_across_refused_input_and_closes_at_authoritative_catch_up() {
    let mut barrier = InputBarrier::default();
    assert!(!barrier.reject_if_open(4));
    barrier.open_through(5);
    assert!(barrier.reject_if_open(6));
    assert_eq!(barrier.high_water, 6);
    barrier.observe_authoritative(5);
    assert!(barrier.reject_if_open(7));
    assert_eq!(barrier.high_water, 7);
    barrier.observe_authoritative(7);
    assert!(!barrier.reject_if_open(8));

    barrier.open_through(0);
    assert!(!barrier.is_open(), "zero names no input");
}

#[test]
fn the_barrier_closes_in_serial_order_across_the_u32_wrap() {
    let mut barrier = InputBarrier::default();
    barrier.open_through(u32::MAX);
    assert!(barrier.reject_if_open(1));
    assert_eq!(barrier.high_water, 1);
    barrier.observe_authoritative(u32::MAX);
    assert_eq!(barrier.high_water, 1);
    barrier.observe_authoritative(1);
    assert!(!barrier.is_open());
}
