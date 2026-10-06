//! Encodes browser input records into the bytes the application asked for.
//!
//! This is the only place Merkur turns input into PTY bytes. It runs on the
//! owner task at the moment a record is admitted to the PTY, against the modes
//! of the terminal that task owns, so a mode the application changed a moment
//! ago is the mode its next key is encoded in. The browser never sees an
//! encoding decision.
//!
//! `encode` is a pure function of the record and the modes: a record refused by
//! a full PTY queue is encoded again on retry, against the modes current then.
//!
//! Keys follow Kitty's reference encoder (`kitty/key_encoding.c`) for every
//! combination of the progressive-enhancement flags, including its legacy
//! encoding when no flag is set. Two additions sit in front of that legacy
//! encoding, where Kitty has none: XTerm's `modifyOtherKeys`, which tmux and Vim
//! negotiate, and the fold of Super, Hyper and Meta into Alt that Merkur has
//! always applied to ⌘ (with ⌘Backspace erasing the line).

use alacritty_terminal::term::TermMode;

use crate::network::input_record::{
    InputRecord, KIND_SHIFT, KIND_TEXT, KeyEvent, KeyRecord, KeyText, MouseAction, MouseButton,
    MouseRecord, WheelDirection, WheelRecord, mods,
};

/// Receives encoded bytes. Implemented by the PTY write payload, which keeps a
/// keystroke inline and never reaches the allocator for one.
pub trait Sink {
    fn put(&mut self, bytes: &[u8]);
}

impl Sink for Vec<u8> {
    #[inline]
    fn put(&mut self, bytes: &[u8]) {
        self.extend_from_slice(bytes);
    }
}

// Kitty's functional key numbers (its Private Use Area table).
const ESCAPE: u32 = 0xE000;
use merkur_wire::input_record::keys::ENTER;
const TAB: u32 = 0xE002;
pub(crate) use merkur_wire::input_record::keys::BACKSPACE;
const INSERT: u32 = 0xE004;
pub(crate) use merkur_wire::input_record::keys::{DELETE, LEFT, RIGHT};
const UP: u32 = 0xE008;
const DOWN: u32 = 0xE009;
const PAGE_UP: u32 = 0xE00A;
const PAGE_DOWN: u32 = 0xE00B;
const HOME: u32 = 0xE00C;
const END: u32 = 0xE00D;
const CAPS_LOCK: u32 = 0xE00E;
const SCROLL_LOCK: u32 = 0xE00F;
const NUM_LOCK: u32 = 0xE010;
const MENU: u32 = 0xE013;
const F1: u32 = 0xE014;
const F2: u32 = 0xE015;
const F3: u32 = 0xE016;
const F4: u32 = 0xE017;
const F5: u32 = 0xE018;
const F6: u32 = 0xE019;
const F7: u32 = 0xE01A;
const F8: u32 = 0xE01B;
const F9: u32 = 0xE01C;
const F10: u32 = 0xE01D;
const F11: u32 = 0xE01E;
const F12: u32 = 0xE01F;
const KP_0: u32 = 0xE037;
const KP_9: u32 = 0xE040;
const KP_DECIMAL: u32 = 0xE041;
const KP_DIVIDE: u32 = 0xE042;
const KP_MULTIPLY: u32 = 0xE043;
const KP_SUBTRACT: u32 = 0xE044;
const KP_ADD: u32 = 0xE045;
const KP_ENTER: u32 = 0xE046;
const KP_EQUAL: u32 = 0xE047;
const KP_LEFT: u32 = 0xE049;
const KP_RIGHT: u32 = 0xE04A;
const KP_UP: u32 = 0xE04B;
const KP_DOWN: u32 = 0xE04C;
const KP_PAGE_UP: u32 = 0xE04D;
const KP_PAGE_DOWN: u32 = 0xE04E;
const KP_HOME: u32 = 0xE04F;
const KP_END: u32 = 0xE050;
const KP_INSERT: u32 = 0xE051;
const KP_DELETE: u32 = 0xE052;
const KP_BEGIN: u32 = 0xE053;
const LEFT_SHIFT: u32 = 0xE061;
const ISO_LEVEL5_SHIFT: u32 = 0xE06E;

const ESC: u8 = 0x1b;
/// Mouse coordinates are 1-based on the wire and offset by 32 in the byte
/// encodings.
const MOUSE_BYTE_OFFSET: u32 = 33;
/// The largest coordinate the one-byte X10 encoding can carry.
const X10_MAX_ENCODED: u32 = 0xff;
/// The largest coordinate the UTF-8 (1005) encoding carries: two-byte UTF-8.
const UTF8_MOUSE_MAX_ENCODED: u32 = 0x7ff;

const BRACKETED_PASTE_OPEN: &[u8] = b"\x1b[200~";
const BRACKETED_PASTE_CLOSE: &[u8] = b"\x1b[201~";

/// Upper bound on the bytes `encode` produces for `record`, beyond which the
/// sink never has to grow. Text is exact: it loses its head byte and a line
/// feed becomes a carriage return one for one, so a commit that fits the
/// inline PTY payload stays inline. Keys and pointer events are bounded
/// constants; paste gains only its two brackets.
pub fn encoded_len_hint(record: &[u8]) -> usize {
    match record.first() {
        Some(head) if head >> KIND_SHIFT == KIND_TEXT => record.len() - 1,
        _ => record.len() + BRACKETED_PASTE_OPEN.len() + BRACKETED_PASTE_CLOSE.len(),
    }
}

pub fn encode(record: &InputRecord<'_>, mode: TermMode, out: &mut impl Sink) {
    match record {
        InputRecord::Key(key) => encode_key(key, mode, out),
        InputRecord::Text(text) => encode_text(text, out),
        InputRecord::Paste(text) => encode_paste(text, mode, out),
        InputRecord::Mouse(mouse) => encode_mouse(mouse, mode, out),
        InputRecord::Wheel(wheel) => encode_wheel(wheel, mode, out),
        InputRecord::Focus(focused) => {
            if mode.contains(TermMode::FOCUS_IN_OUT) {
                out.put(if *focused { b"\x1b[I" } else { b"\x1b[O" });
            }
        }
    }
}

/// Committed text from an input method, the on-screen keyboard or a native
/// insertion. A line feed is the Enter the user typed, which a terminal sends
/// as a carriage return.
fn encode_text(text: &str, out: &mut impl Sink) {
    for (index, line) in text.split('\n').enumerate() {
        if index != 0 {
            out.put(b"\r");
        }
        out.put(line.as_bytes());
    }
}

/// Bracketed paste is the application's defence against pasted commands, so
/// the paste can never close its own brackets: every ESC inside it is dropped.
fn encode_paste(text: &str, mode: TermMode, out: &mut impl Sink) {
    if !mode.contains(TermMode::BRACKETED_PASTE) {
        out.put(text.as_bytes());
        return;
    }
    out.put(BRACKETED_PASTE_OPEN);
    // memchr's SIMD search finds each ESC; the spans between them are the
    // bytes kept.
    let bytes = text.as_bytes();
    let mut start = 0;
    for esc in memchr::memchr_iter(ESC, bytes) {
        out.put(&bytes[start..esc]);
        start = esc + 1;
    }
    out.put(&bytes[start..]);
    out.put(BRACKETED_PASTE_CLOSE);
}

#[derive(Clone, Copy)]
struct KittyFlags {
    disambiguate: bool,
    report_events: bool,
    report_alternates: bool,
    report_all_keys: bool,
    report_text: bool,
}

impl KittyFlags {
    fn of(mode: TermMode) -> Self {
        Self {
            disambiguate: mode.contains(TermMode::DISAMBIGUATE_ESC_CODES),
            report_events: mode.contains(TermMode::REPORT_EVENT_TYPES),
            report_alternates: mode.contains(TermMode::REPORT_ALTERNATE_KEYS),
            report_all_keys: mode.contains(TermMode::REPORT_ALL_KEYS_AS_ESC),
            report_text: mode.contains(TermMode::REPORT_ASSOCIATED_TEXT),
        }
    }

    fn any(self) -> bool {
        self.disambiguate
            || self.report_events
            || self.report_alternates
            || self.report_all_keys
            || self.report_text
    }

    /// Kitty's legacy mode for functional keys: nothing that changes their
    /// encoding is set.
    fn functional_legacy(self) -> bool {
        !self.report_events && !self.disambiguate && !self.report_all_keys
    }
}

fn encode_key(key: &KeyRecord<'_>, mode: TermMode, out: &mut impl Sink) {
    let flags = KittyFlags::of(mode);
    let kitty = flags.any();
    let mut mods = key.mods;
    if !kitty {
        // Legacy encodings cannot carry the lock state.
        mods &= !mods::LOCKS;
        // Nor Super, Hyper or Meta: ⌘ has always meant Alt here, and
        // ⌘Backspace erases the line as it does in every macOS text field.
        if mods & (mods::SUPER | mods::HYPER | mods::META) != 0 {
            if key.key == BACKSPACE && mods == mods::SUPER {
                if key.event != KeyEvent::Release {
                    out.put(&[0x15]);
                }
                return;
            }
            mods = (mods & !(mods::SUPER | mods::HYPER | mods::META)) | mods::ALT;
        }
    }
    if !flags.report_events && key.event == KeyEvent::Release {
        return;
    }
    if !flags.report_all_keys && is_modifier_key(key.key) {
        return;
    }
    let mut code = key.key;
    if !flags.disambiguate && !flags.report_all_keys && (KP_0..=KP_BEGIN).contains(&code) {
        code = keypad_to_main(code);
    }

    let mut text_buf = [0u8; 4];
    let text: Option<&str> = match key.text {
        KeyText::None => None,
        KeyText::Implied(c) => Some(c.encode_utf8(&mut text_buf)),
        KeyText::Explicit(text) => Some(text),
    };
    if !flags.report_all_keys
        && key.event != KeyEvent::Release
        && let Some(text) = text
    {
        out.put(text.as_bytes());
        return;
    }

    if !kitty && key.event != KeyEvent::Release {
        let level = if mode.contains(TermMode::MODIFY_OTHER_KEYS_2) {
            2
        } else if mode.contains(TermMode::MODIFY_OTHER_KEYS_1) {
            1
        } else {
            0
        };
        if level != 0
            && let Some(reported) = modify_other_keys_code(code, key.shifted, mods, level)
        {
            out.put(b"\x1b[27;");
            put_decimal(out, u32::from(mods) + 1);
            out.put(b";");
            put_decimal(out, reported);
            out.put(b"~");
            return;
        }
    }

    let is_functional = (0xE000..=ISO_LEVEL5_SHIFT).contains(&code);
    if is_functional {
        encode_functional_key(code, key.event, mods, flags, mode, text, out);
    } else {
        encode_text_key(code, key, mods, flags, text, out);
    }
}

fn encode_functional_key(
    code: u32,
    event: KeyEvent,
    mods: u8,
    flags: KittyFlags,
    mode: TermMode,
    text: Option<&str>,
    out: &mut impl Sink,
) {
    let legacy = flags.functional_legacy();
    if mode.contains(TermMode::APP_CURSOR) && legacy && mods == 0 {
        let application = match code {
            UP => Some(b'A'),
            DOWN => Some(b'B'),
            RIGHT => Some(b'C'),
            LEFT => Some(b'D'),
            KP_BEGIN => Some(b'E'),
            END => Some(b'F'),
            HOME => Some(b'H'),
            _ => None,
        };
        if let Some(final_byte) = application {
            out.put(&[ESC, b'O', final_byte]);
            return;
        }
    }
    if mods == 0 {
        if !flags.disambiguate && !flags.report_all_keys && code == ESCAPE {
            out.put(&[ESC]);
            return;
        }
        if legacy {
            let ss3 = match code {
                F1 => Some(b'P'),
                F2 => Some(b'Q'),
                F3 => Some(b'R'),
                F4 => Some(b'S'),
                _ => None,
            };
            if let Some(final_byte) = ss3 {
                out.put(&[ESC, b'O', final_byte]);
                return;
            }
        }
    } else if legacy && legacy_functional_with_mods(code, mods, out) {
        return;
    }
    // Enter, Tab and Backspace keep their plain bytes until every key is
    // reported, and never report their release before then, so `reset` still
    // works after a program that enabled the protocol crashes.
    if mods & !mods::LOCKS == 0 && !flags.report_all_keys {
        let plain: Option<&[u8]> = match code {
            ENTER => Some(b"\r"),
            BACKSPACE => Some(b"\x7f"),
            TAB => Some(b"\t"),
            _ => None,
        };
        if let Some(bytes) = plain {
            if event != KeyEvent::Release {
                out.put(bytes);
            }
            return;
        }
    }
    let (number, trailer) = match code {
        ESCAPE => (27, b'u'),
        ENTER => (13, b'u'),
        TAB => (9, b'u'),
        BACKSPACE => (127, b'u'),
        INSERT => (2, b'~'),
        DELETE => (3, b'~'),
        LEFT => (1, b'D'),
        RIGHT => (1, b'C'),
        UP => (1, b'A'),
        DOWN => (1, b'B'),
        PAGE_UP => (5, b'~'),
        PAGE_DOWN => (6, b'~'),
        HOME => (1, b'H'),
        END => (1, b'F'),
        F1 => (1, b'P'),
        F2 => (1, b'Q'),
        F3 => (13, b'~'),
        F4 => (1, b'S'),
        F5 => (15, b'~'),
        F6 => (17, b'~'),
        F7 => (18, b'~'),
        F8 => (19, b'~'),
        F9 => (20, b'~'),
        F10 => (21, b'~'),
        F11 => (23, b'~'),
        F12 => (24, b'~'),
        KP_BEGIN => (1, b'E'),
        // XTerm's F16, which is where legacy terminals put Menu.
        MENU if legacy => (29, b'~'),
        _ => (code, b'u'),
    };
    let action = reported_action(event, flags);
    let text = associated_text(event, flags, text);
    serialize(number, None, None, mods, action, text, trailer, out);
}

/// Kitty's legacy encoding of Enter, Escape, Backspace and Tab under
/// modifiers. Returns whether it applied.
fn legacy_functional_with_mods(code: u32, mods: u8, out: &mut impl Sink) -> bool {
    let alt = mods & mods::ALT != 0;
    let main: &[u8] = match code {
        ENTER => b"\r",
        ESCAPE => b"\x1b",
        BACKSPACE if mods & mods::CTRL != 0 => b"\x08",
        BACKSPACE => b"\x7f",
        TAB if mods & mods::SHIFT != 0 => {
            out.put(if alt { b"\x1b\x1b[Z" } else { b"\x1b[Z" });
            return true;
        }
        TAB => b"\t",
        _ => return false,
    };
    if alt {
        out.put(&[ESC]);
    }
    out.put(main);
    true
}

fn encode_text_key(
    code: u32,
    key: &KeyRecord<'_>,
    mods: u8,
    flags: KittyFlags,
    text: Option<&str>,
    out: &mut impl Sink,
) {
    let action = reported_action(key.event, flags);
    let shift = mods & mods::SHIFT != 0;
    let add_alternates =
        flags.report_alternates && ((key.shifted.is_some() && shift) || key.base.is_some());
    let text = associated_text(key.event, flags, text);
    if action.is_none() && !add_alternates && text.is_none() {
        if mods == 0 {
            if flags.report_all_keys {
                serialize(code, None, None, 0, None, None, b'u', out);
            } else {
                put_char(out, code);
            }
            return;
        }
        if !flags.disambiguate && !flags.report_all_keys {
            if (is_legacy_ascii(code) || key.shifted.is_some_and(is_legacy_ascii))
                && legacy_printable(code, key.shifted, mods, out)
            {
                return;
            }
            // A key off the ASCII range (Cyrillic, Greek, …) under Ctrl or Alt
            // is the key at its position on a US layout, which is what a
            // program binding Ctrl+C means.
            let ctrl_or_alt =
                matches!(mods, mods::CTRL | mods::ALT) || mods == mods::CTRL | mods::ALT;
            if ctrl_or_alt
                && let Some(base) = key.base
                && !is_legacy_ascii(code)
                && is_legacy_ascii(base)
                && legacy_printable(base, None, mods, out)
            {
                return;
            }
        }
    }
    let (shifted, base) = if add_alternates {
        (key.shifted.filter(|_| shift), key.base)
    } else {
        (None, None)
    };
    serialize(code, shifted, base, mods, action, text, b'u', out);
}

/// Kitty's legacy encoding of a printable ASCII key under modifiers. Returns
/// whether the combination has one.
fn legacy_printable(code: u32, shifted: Option<u32>, all_mods: u8, out: &mut impl Sink) -> bool {
    let mut key = code;
    let mut mods = all_mods;
    if mods & mods::SHIFT != 0
        && let Some(shifted) = shifted
        && shifted != key
        && (mods & mods::CTRL == 0 || !(u32::from('a')..=u32::from('z')).contains(&key))
    {
        key = shifted;
        mods &= !mods::SHIFT;
    }
    if all_mods == mods::SHIFT {
        put_char(out, key);
    } else if mods == mods::ALT {
        out.put(&[ESC]);
        put_char(out, key);
    } else if mods == mods::CTRL {
        put_char(out, ctrl_mapped(key));
    } else if mods == mods::CTRL | mods::ALT {
        out.put(&[ESC]);
        put_char(out, ctrl_mapped(key));
    } else if key == u32::from(' ') && mods == mods::CTRL | mods::SHIFT {
        out.put(&[0]);
    } else if key == u32::from(' ') && mods == mods::ALT | mods::SHIFT {
        out.put(b"\x1b ");
    } else {
        return false;
    }
    true
}

/// The control character Ctrl turns `key` into, or `key` itself where it has
/// none. Kitty's table, which is XTerm's.
fn ctrl_mapped(key: u32) -> u32 {
    let Ok(byte) = u8::try_from(key) else {
        return key;
    };
    u32::from(match byte {
        b' ' | b'2' | b'@' => 0,
        b'/' | b'7' | b'_' => 31,
        b'3' | b'[' => 27,
        b'4' | b'\\' => 28,
        b'5' | b']' => 29,
        b'6' | b'^' | b'~' => 30,
        b'8' | b'?' => 127,
        b'a'..=b'z' => byte - b'a' + 1,
        _ => byte,
    })
}

fn is_legacy_ascii(key: u32) -> bool {
    matches!(u8::try_from(key), Ok(b'a'..=b'z' | b'0'..=b'9' | b' '))
        || matches!(
            u8::try_from(key),
            Ok(b'!'
                | b'@'
                | b'#'
                | b'$'
                | b'%'
                | b'^'
                | b'&'
                | b'*'
                | b'('
                | b')'
                | b'`'
                | b'~'
                | b'-'
                | b'_'
                | b'='
                | b'+'
                | b'['
                | b'{'
                | b']'
                | b'}'
                | b'\\'
                | b'|'
                | b';'
                | b':'
                | b'\''
                | b'"'
                | b','
                | b'<'
                | b'.'
                | b'>'
                | b'/'
                | b'?')
        )
}

/// XTerm's `modifyOtherKeys`: the key number to report as
/// `CSI 27 ; modifiers ; key ~`, or `None` where the key keeps its ordinary
/// encoding. Level 1 leaves every combination with a well-known meaning alone;
/// level 2 reports every modified key except a Shift that only chose a symbol.
fn modify_other_keys_code(code: u32, shifted: Option<u32>, mods: u8, level: u8) -> Option<u32> {
    if mods == 0 {
        return None;
    }
    let alt = mods & mods::ALT != 0;
    let ctrl = mods & mods::CTRL != 0;
    let shift_only = mods == mods::SHIFT;
    match code {
        TAB => Some(9),
        ENTER => Some(13),
        ESCAPE => (alt || level == 2).then_some(27),
        BACKSPACE => (level == 2 && mods != mods::CTRL).then_some(127),
        _ if (0xE000..=ISO_LEVEL5_SHIFT).contains(&code) => None,
        _ => {
            let produced = match shifted {
                Some(shifted) if mods & mods::SHIFT != 0 => shifted,
                _ => code,
            };
            let report = if level == 1 {
                alt || (ctrl && ctrl_mapped(produced) == produced)
            } else {
                alt || ctrl
                    || (shift_only
                        && char::from_u32(produced)
                            .is_some_and(|c| c == ' ' || c.is_uppercase() || c.is_lowercase()))
            };
            report.then_some(produced)
        }
    }
}

fn keypad_to_main(code: u32) -> u32 {
    match code {
        KP_ENTER => ENTER,
        KP_HOME => HOME,
        KP_END => END,
        KP_INSERT => INSERT,
        KP_DELETE => DELETE,
        KP_PAGE_UP => PAGE_UP,
        KP_PAGE_DOWN => PAGE_DOWN,
        KP_UP => UP,
        KP_DOWN => DOWN,
        KP_LEFT => LEFT,
        KP_RIGHT => RIGHT,
        KP_0..=KP_9 => u32::from('0') + (code - KP_0),
        KP_DECIMAL => u32::from('.'),
        KP_DIVIDE => u32::from('/'),
        KP_MULTIPLY => u32::from('*'),
        KP_SUBTRACT => u32::from('-'),
        KP_ADD => u32::from('+'),
        KP_EQUAL => u32::from('='),
        _ => code,
    }
}

fn is_modifier_key(code: u32) -> bool {
    (LEFT_SHIFT..=ISO_LEVEL5_SHIFT).contains(&code)
        || matches!(code, CAPS_LOCK | SCROLL_LOCK | NUM_LOCK)
}

/// The event type Kitty appends, when event reporting is on and the event is
/// not a plain press.
fn reported_action(event: KeyEvent, flags: KittyFlags) -> Option<u32> {
    if !flags.report_events {
        return None;
    }
    match event {
        KeyEvent::Press => None,
        KeyEvent::Repeat => Some(2),
        KeyEvent::Release => Some(3),
    }
}

fn associated_text(event: KeyEvent, flags: KittyFlags, text: Option<&str>) -> Option<&str> {
    (flags.report_text && event != KeyEvent::Release)
        .then_some(text)
        .flatten()
}

/// `CSI key[:shifted[:base]] [; mods[:event] [; text]] trailer`, omitting
/// every field Kitty omits.
fn serialize(
    key: u32,
    shifted: Option<u32>,
    base: Option<u32>,
    mods: u8,
    action: Option<u32>,
    text: Option<&str>,
    trailer: u8,
    out: &mut impl Sink,
) {
    let alternates = shifted.is_some() || base.is_some();
    let second = mods != 0 || action.is_some();
    out.put(b"\x1b[");
    if key != 1 || alternates || second || text.is_some() {
        put_decimal(out, key);
    }
    if alternates {
        out.put(b":");
        if let Some(shifted) = shifted {
            put_decimal(out, shifted);
        }
        if let Some(base) = base {
            out.put(b":");
            put_decimal(out, base);
        }
    }
    if second || text.is_some() {
        out.put(b";");
        if second {
            put_decimal(out, u32::from(mods) + 1);
        }
        if let Some(action) = action {
            out.put(b":");
            put_decimal(out, action);
        }
    }
    if let Some(text) = text {
        for (index, c) in text.chars().enumerate() {
            out.put(if index == 0 { b";" } else { b":" });
            put_decimal(out, u32::from(c));
        }
    }
    out.put(&[trailer]);
}

fn encode_mouse(mouse: &MouseRecord, mode: TermMode, out: &mut impl Sink) {
    if !mode.intersects(TermMode::MOUSE_MODE) {
        return;
    }
    let button = match mouse.button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::None => 3,
    };
    let code = match mouse.action {
        MouseAction::Motion => {
            let reported = mode.contains(TermMode::MOUSE_MOTION)
                || (mode.contains(TermMode::MOUSE_DRAG) && mouse.button != MouseButton::None);
            if !reported {
                return;
            }
            32 + button
        }
        MouseAction::Press | MouseAction::Release => button,
    };
    put_mouse_report(
        code + pointer_mods(mouse.mods),
        mouse.action == MouseAction::Release,
        mouse.column,
        mouse.row,
        mode,
        out,
    );
}

fn encode_wheel(wheel: &WheelRecord, mode: TermMode, out: &mut impl Sink) {
    if mode.intersects(TermMode::MOUSE_MODE) {
        let direction = match wheel.direction {
            WheelDirection::Up => 0,
            WheelDirection::Down => 1,
            WheelDirection::Left => 2,
            WheelDirection::Right => 3,
        };
        for _ in 0..wheel.count {
            put_mouse_report(
                64 + direction + pointer_mods(wheel.mods),
                false,
                wheel.column,
                wheel.row,
                mode,
                out,
            );
        }
        return;
    }
    if mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL) {
        let final_byte = match wheel.direction {
            WheelDirection::Up => b'A',
            WheelDirection::Down => b'B',
            WheelDirection::Left | WheelDirection::Right => return,
        };
        let introducer = if mode.contains(TermMode::APP_CURSOR) {
            b'O'
        } else {
            b'['
        };
        for _ in 0..wheel.count {
            out.put(&[ESC, introducer, final_byte]);
        }
    }
}

fn pointer_mods(record_mods: u8) -> u32 {
    let mut value = 0;
    if record_mods & mods::SHIFT != 0 {
        value += 4;
    }
    if record_mods & mods::ALT != 0 {
        value += 8;
    }
    if record_mods & mods::CTRL != 0 {
        value += 16;
    }
    value
}

/// One mouse report in whichever encoding the application enabled. The byte
/// encodings cannot say which button was released, and cannot carry a
/// position past their range, where XTerm reports nothing rather than a wrong
/// cell.
fn put_mouse_report(
    code: u32,
    release: bool,
    column: u32,
    row: u32,
    mode: TermMode,
    out: &mut impl Sink,
) {
    if mode.contains(TermMode::SGR_MOUSE) {
        out.put(b"\x1b[<");
        put_decimal(out, code);
        out.put(b";");
        put_decimal(out, column.saturating_add(1));
        out.put(b";");
        put_decimal(out, row.saturating_add(1));
        out.put(if release { b"m" } else { b"M" });
        return;
    }
    let code = if release { (code & !0b11) | 3 } else { code };
    let encoded = [
        code + 32,
        column.saturating_add(MOUSE_BYTE_OFFSET),
        row.saturating_add(MOUSE_BYTE_OFFSET),
    ];
    if mode.contains(TermMode::UTF8_MOUSE) {
        if encoded.iter().any(|&value| value > UTF8_MOUSE_MAX_ENCODED) {
            return;
        }
        out.put(b"\x1b[M");
        for value in encoded {
            put_char(out, value);
        }
        return;
    }
    if encoded.iter().any(|&value| value > X10_MAX_ENCODED) {
        return;
    }
    out.put(&[
        ESC,
        b'[',
        b'M',
        encoded[0] as u8,
        encoded[1] as u8,
        encoded[2] as u8,
    ]);
}

#[inline]
fn put_char(out: &mut impl Sink, code: u32) {
    if let Some(c) = char::from_u32(code) {
        let mut buf = [0u8; 4];
        out.put(c.encode_utf8(&mut buf).as_bytes());
    }
}

#[inline]
fn put_decimal(out: &mut impl Sink, mut value: u32) {
    let mut digits = [0u8; 10];
    let mut start = digits.len();
    loop {
        start -= 1;
        digits[start] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    out.put(&digits[start..]);
}

#[cfg(test)]
#[path = "input_encoder_tests.rs"]
mod tests;
