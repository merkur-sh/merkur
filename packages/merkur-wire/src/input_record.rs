//! Client input records: what the user did, never the bytes an application
//! reads.
//!
//! A client cannot encode keys: the modes that decide the encoding (the
//! Kitty keyboard flags, DECCKM, modifyOtherKeys, bracketed paste, mouse
//! reporting, focus reporting) change in PTY output the client sees one round
//! trip late. It therefore sends each input as a record and the dataplane
//! encodes it against the terminal it owns, at the moment the record is
//! admitted to the PTY (`pty::input_encoder`). The native client encodes with
//! [`build`] and the daemon decodes with [`decode`], so both ends share one
//! codec.
//!
//! Every entry of an `input_run` and the body of a `sequenced_keystroke` is one
//! record. `validate` is exhaustive: a record it accepts decodes without
//! failure, so the run parser can reject a malformed run before any PTY write.
//! Mirrored by `packages/protocol/src/input-record.ts`.
//!
//! A record opens with a head byte whose top three bits name its kind:
//!
//! ```text
//! Key   0  head[4:3] event (press, repeat, release), [2] FN, [1] MODS, [0] EXT
//!          key: FN ? u8 index (code = 0xE000 + index) : LEB128 code point
//!          [mods u8] [ext u8] [shifted LEB128] [base LEB128] [text UTF-8 = rest]
//! Text  1  head | UTF-8 (rest)
//! Paste 2  head | UTF-8 (rest)
//! Mouse 3  head[4:3] action (press, release, motion), [2:0] shift alt ctrl
//!          | button u8 | column LEB128 | row LEB128
//! Wheel 4  head[4:3] direction (up, down, left, right), [2:0] shift alt ctrl
//!          | count u8 | column LEB128 | row LEB128
//! Focus 5  head[0] focused
//! ```

pub const KIND_KEY: u8 = 0;
pub const KIND_TEXT: u8 = 1;
pub const KIND_PASTE: u8 = 2;
pub const KIND_MOUSE: u8 = 3;
pub const KIND_WHEEL: u8 = 4;
pub const KIND_FOCUS: u8 = 5;

pub const KIND_SHIFT: u8 = 5;
const KEY_HEAD_FN: u8 = 1 << 2;
const KEY_HEAD_MODS: u8 = 1 << 1;
const KEY_HEAD_EXT: u8 = 1 << 0;
const EXT_SHIFTED: u8 = 1 << 0;
const EXT_BASE: u8 = 1 << 1;
const EXT_TEXT: u8 = 1 << 2;
const EXT_NO_TEXT: u8 = 1 << 3;
const EXT_DEFINED: u8 = EXT_SHIFTED | EXT_BASE | EXT_TEXT | EXT_NO_TEXT;

/// Kitty's functional keys occupy `FUNCTIONAL_KEY_FIRST..=FUNCTIONAL_KEY_LAST`
/// of the Private Use Area, in the order of the protocol's functional-key table.
pub const FUNCTIONAL_KEY_FIRST: u32 = 57344;
pub const FUNCTIONAL_KEY_LAST: u32 = 57454;

/// Functional keys both ends name: Enter, which the speculative model never
/// produces, and the editing keys it can, on which alone (besides printables)
/// the daemon honours a modelled claim.
pub mod keys {
    pub const ENTER: u32 = 0xE001;
    pub const BACKSPACE: u32 = 0xE003;
    pub const DELETE: u32 = 0xE005;
    pub const LEFT: u32 = 0xE006;
    pub const RIGHT: u32 = 0xE007;
}

/// Kitty modifier bits, in the protocol's own order.
pub mod mods {
    pub const SHIFT: u8 = 1;
    pub const ALT: u8 = 1 << 1;
    pub const CTRL: u8 = 1 << 2;
    pub const SUPER: u8 = 1 << 3;
    pub const HYPER: u8 = 1 << 4;
    pub const META: u8 = 1 << 5;
    pub const CAPS_LOCK: u8 = 1 << 6;
    pub const NUM_LOCK: u8 = 1 << 7;
    pub const LOCKS: u8 = CAPS_LOCK | NUM_LOCK;
    /// Modifiers after which a key produces no text of its own.
    pub const TEXT_SUPPRESSING: u8 = ALT | CTRL | SUPER | HYPER | META;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyEvent {
    Press,
    Repeat,
    Release,
}

/// The text a key produces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyText<'a> {
    None,
    /// The key's own code point, or its shifted one while Shift is held.
    Implied(char),
    Explicit(&'a str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyRecord<'a> {
    pub event: KeyEvent,
    /// Kitty's key number: the unshifted code point, or a functional key's
    /// Private Use Area code.
    pub key: u32,
    pub mods: u8,
    pub shifted: Option<u32>,
    /// The key at this position on a PC-101 US layout.
    pub base: Option<u32>,
    pub text: KeyText<'a>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseAction {
    Press,
    Release,
    Motion,
}

/// Mouse buttons as the X10 protocol numbers them; `None` is motion with no
/// button held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MouseRecord {
    pub action: MouseAction,
    pub button: MouseButton,
    /// Shift, Alt and Ctrl as `mods::{SHIFT, ALT, CTRL}`.
    pub mods: u8,
    pub column: u32,
    pub row: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WheelDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WheelRecord {
    pub direction: WheelDirection,
    pub mods: u8,
    pub count: u8,
    pub column: u32,
    pub row: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputRecord<'a> {
    Key(KeyRecord<'a>),
    Text(&'a str),
    Paste(&'a str),
    Mouse(MouseRecord),
    Wheel(WheelRecord),
    Focus(bool),
}

/// Whether `bytes` is exactly one canonical record.
#[inline]
pub fn validate(bytes: &[u8]) -> bool {
    decode(bytes).is_some()
}

/// Decodes exactly one canonical record, borrowing its text.
pub fn decode(bytes: &[u8]) -> Option<InputRecord<'_>> {
    let (&head, body) = bytes.split_first()?;
    match head >> KIND_SHIFT {
        KIND_KEY => decode_key(head, body).map(InputRecord::Key),
        KIND_TEXT => non_empty_utf8(head, body).map(InputRecord::Text),
        KIND_PASTE => non_empty_utf8(head, body).map(InputRecord::Paste),
        KIND_MOUSE => decode_mouse(head, body).map(InputRecord::Mouse),
        KIND_WHEEL => decode_wheel(head, body).map(InputRecord::Wheel),
        KIND_FOCUS => {
            if head & 0b1_1110 != 0 || !body.is_empty() {
                return None;
            }
            Some(InputRecord::Focus(head & 1 != 0))
        }
        _ => None,
    }
}

fn decode_key(head: u8, body: &[u8]) -> Option<KeyRecord<'_>> {
    let event = match (head >> 3) & 0b11 {
        0 => KeyEvent::Press,
        1 => KeyEvent::Repeat,
        2 => KeyEvent::Release,
        _ => return None,
    };
    let mut reader = Reader(body);
    let functional = head & KEY_HEAD_FN != 0;
    let key = if functional {
        let code = FUNCTIONAL_KEY_FIRST + u32::from(reader.byte()?);
        if code > FUNCTIONAL_KEY_LAST {
            return None;
        }
        code
    } else {
        let code = reader.scalar()?;
        // Control characters are named by their functional keys, and the
        // Private Use Area block Kitty assigns them is reachable only by index.
        if is_control(code) || (FUNCTIONAL_KEY_FIRST..=FUNCTIONAL_KEY_LAST).contains(&code) {
            return None;
        }
        code
    };
    let mods = if head & KEY_HEAD_MODS != 0 {
        let mods = reader.byte()?;
        // An absent byte already means "no modifiers"; a zero one is a second
        // spelling of the same record.
        if mods == 0 {
            return None;
        }
        mods
    } else {
        0
    };
    let ext = if head & KEY_HEAD_EXT != 0 {
        let ext = reader.byte()?;
        if ext == 0
            || ext & !EXT_DEFINED != 0
            || ext & (EXT_TEXT | EXT_NO_TEXT) == EXT_TEXT | EXT_NO_TEXT
        {
            return None;
        }
        ext
    } else {
        0
    };
    let shifted = if ext & EXT_SHIFTED != 0 {
        Some(printable_scalar(reader.scalar()?)?)
    } else {
        None
    };
    let base = if ext & EXT_BASE != 0 {
        Some(reader.scalar()?)
    } else {
        None
    };
    let implied = implied_text(event, functional, key, mods, shifted);
    let text = if ext & EXT_TEXT != 0 {
        let text = std::str::from_utf8(reader.rest()).ok()?;
        // Kitty's associated text never carries control codes, and a record
        // with no text says so with `EXT_NO_TEXT`, not with an empty string.
        if text.is_empty() || text.chars().any(|c| is_control(u32::from(c))) {
            return None;
        }
        // The text a key implies is never spelled out.
        if let KeyText::Implied(c) = implied
            && text.chars().eq([c])
        {
            return None;
        }
        KeyText::Explicit(text)
    } else {
        if !reader.rest().is_empty() {
            return None;
        }
        if ext & EXT_NO_TEXT != 0 {
            // "No text" is spelled only where the key would imply some.
            if implied == KeyText::None {
                return None;
            }
            KeyText::None
        } else {
            implied
        }
    };
    Some(KeyRecord {
        event,
        key,
        mods,
        shifted,
        base,
        text,
    })
}

/// The text a key produces when its record does not say otherwise: its own
/// code point (its shifted one while Shift is held), unless it is a release, is
/// functional, or a text-suppressing modifier is held.
fn implied_text(
    event: KeyEvent,
    functional: bool,
    key: u32,
    mods: u8,
    shifted: Option<u32>,
) -> KeyText<'static> {
    match implied_code(event == KeyEvent::Release, functional, key, mods, shifted)
        .and_then(char::from_u32)
    {
        Some(c) => KeyText::Implied(c),
        None => KeyText::None,
    }
}

fn implied_code(
    release: bool,
    functional: bool,
    key: u32,
    mods: u8,
    shifted: Option<u32>,
) -> Option<u32> {
    if release || functional || mods & mods::TEXT_SUPPRESSING != 0 {
        return None;
    }
    Some(match shifted {
        Some(shifted) if mods & mods::SHIFT != 0 => shifted,
        _ => key,
    })
}

fn decode_mouse(head: u8, body: &[u8]) -> Option<MouseRecord> {
    let action = match (head >> 3) & 0b11 {
        0 => MouseAction::Press,
        1 => MouseAction::Release,
        2 => MouseAction::Motion,
        _ => return None,
    };
    let mut reader = Reader(body);
    let button = match reader.byte()? {
        0 => MouseButton::Left,
        1 => MouseButton::Middle,
        2 => MouseButton::Right,
        // Only motion can happen with no button held.
        3 if action == MouseAction::Motion => MouseButton::None,
        _ => return None,
    };
    let column = reader.leb128()?;
    let row = reader.leb128()?;
    if !reader.rest().is_empty() {
        return None;
    }
    Some(MouseRecord {
        action,
        button,
        mods: head & 0b111,
        column,
        row,
    })
}

fn decode_wheel(head: u8, body: &[u8]) -> Option<WheelRecord> {
    let direction = match (head >> 3) & 0b11 {
        0 => WheelDirection::Up,
        1 => WheelDirection::Down,
        2 => WheelDirection::Left,
        _ => WheelDirection::Right,
    };
    let mut reader = Reader(body);
    let count = reader.byte()?;
    if count == 0 {
        return None;
    }
    let column = reader.leb128()?;
    let row = reader.leb128()?;
    if !reader.rest().is_empty() {
        return None;
    }
    Some(WheelRecord {
        direction,
        mods: head & 0b111,
        count,
        column,
        row,
    })
}

fn non_empty_utf8(head: u8, body: &[u8]) -> Option<&str> {
    if head & 0b1_1111 != 0 || body.is_empty() {
        return None;
    }
    std::str::from_utf8(body).ok()
}

#[inline]
fn is_control(code: u32) -> bool {
    code < 0x20 || (0x7f..=0x9f).contains(&code)
}

fn printable_scalar(code: u32) -> Option<u32> {
    (!is_control(code)).then_some(code)
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    #[inline]
    fn byte(&mut self) -> Option<u8> {
        let (&byte, rest) = self.0.split_first()?;
        self.0 = rest;
        Some(byte)
    }

    /// Canonical unsigned LEB128 of at most `u32::MAX`: no redundant trailing
    /// zero groups, so every value has exactly one spelling.
    fn leb128(&mut self) -> Option<u32> {
        let mut value = 0u32;
        for shift in (0..35).step_by(7) {
            let byte = self.byte()?;
            let group = u32::from(byte & 0x7f);
            if shift == 28 && group > 0x0f {
                return None;
            }
            value |= group << shift;
            if byte & 0x80 == 0 {
                if byte == 0 && shift != 0 {
                    return None;
                }
                return Some(value);
            }
        }
        None
    }

    fn scalar(&mut self) -> Option<u32> {
        let value = self.leb128()?;
        char::from_u32(value).map(u32::from)
    }

    fn rest(&mut self) -> &'a [u8] {
        std::mem::take(&mut self.0)
    }
}

/// Records in their one canonical spelling: what a client sends, and exactly
/// what [`decode`] accepts.
pub mod build {
    use super::*;

    fn push_leb128(out: &mut Vec<u8>, mut value: u32) {
        loop {
            let group = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(group);
                return;
            }
            out.push(group | 0x80);
        }
    }

    #[derive(Clone, Copy, Debug, Default)]
    pub struct Key<'a> {
        pub event: u8,
        pub key: u32,
        pub mods: u8,
        pub shifted: Option<u32>,
        pub base: Option<u32>,
        /// `Some("")` spells "no text"; `None` leaves the text implied.
        pub text: Option<&'a str>,
    }

    pub fn key(spec: Key<'_>) -> Vec<u8> {
        let functional = (FUNCTIONAL_KEY_FIRST..=FUNCTIONAL_KEY_LAST).contains(&spec.key);
        let mut ext = 0;
        if spec.shifted.is_some() {
            ext |= EXT_SHIFTED;
        }
        if spec.base.is_some() {
            ext |= EXT_BASE;
        }
        match spec.text {
            Some("") => ext |= EXT_NO_TEXT,
            Some(_) => ext |= EXT_TEXT,
            None => {}
        }
        let mut head = spec.event << 3;
        if functional {
            head |= KEY_HEAD_FN;
        }
        if spec.mods != 0 {
            head |= KEY_HEAD_MODS;
        }
        if ext != 0 {
            head |= KEY_HEAD_EXT;
        }
        let mut out = vec![head];
        if functional {
            out.push((spec.key - FUNCTIONAL_KEY_FIRST) as u8);
        } else {
            push_leb128(&mut out, spec.key);
        }
        if spec.mods != 0 {
            out.push(spec.mods);
        }
        if ext != 0 {
            out.push(ext);
        }
        if let Some(shifted) = spec.shifted {
            push_leb128(&mut out, shifted);
        }
        if let Some(base) = spec.base {
            push_leb128(&mut out, base);
        }
        if let Some(text) = spec.text {
            out.extend_from_slice(text.as_bytes());
        }
        out
    }

    /// A key that typed `produced`, or nothing, spelled canonically: the text
    /// stays implied when it is exactly what the key implies, and is stated
    /// otherwise, as `encodeKeyRecordInto` spells it. `spec.text` is ignored.
    pub fn key_typing(spec: Key<'_>, produced: Option<&str>) -> Vec<u8> {
        let functional = (FUNCTIONAL_KEY_FIRST..=FUNCTIONAL_KEY_LAST).contains(&spec.key);
        let implied = implied_code(
            spec.event == 2,
            functional,
            spec.key,
            spec.mods,
            spec.shifted,
        );
        let text = match (produced, implied) {
            (None, None) => None,
            (None, Some(_)) => Some(""),
            (Some(text), Some(implied)) if sole_code(text) == Some(implied) => None,
            (Some(text), _) => Some(text),
        };
        key(Key { text, ..spec })
    }

    fn sole_code(text: &str) -> Option<u32> {
        let mut chars = text.chars();
        let first = chars.next()?;
        chars.next().is_none().then_some(u32::from(first))
    }

    /// A press of `c` with no modifiers: exactly what a plain keystroke sends.
    pub fn press(c: char) -> Vec<u8> {
        key(Key {
            key: u32::from(c),
            ..Key::default()
        })
    }

    pub fn functional(code: u32, event: u8, mods: u8) -> Vec<u8> {
        key(Key {
            event,
            key: code,
            mods,
            ..Key::default()
        })
    }

    pub fn text(text: &str) -> Vec<u8> {
        let mut out = vec![KIND_TEXT << 5];
        out.extend_from_slice(text.as_bytes());
        out
    }

    pub fn paste(text: &str) -> Vec<u8> {
        let mut out = vec![KIND_PASTE << 5];
        out.extend_from_slice(text.as_bytes());
        out
    }

    pub fn mouse(action: u8, button: u8, mods: u8, column: u32, row: u32) -> Vec<u8> {
        let mut out = vec![(KIND_MOUSE << 5) | (action << 3) | mods, button];
        push_leb128(&mut out, column);
        push_leb128(&mut out, row);
        out
    }

    pub fn wheel(direction: u8, mods: u8, count: u8, column: u32, row: u32) -> Vec<u8> {
        let mut out = vec![(KIND_WHEEL << 5) | (direction << 3) | mods, count];
        push_leb128(&mut out, column);
        push_leb128(&mut out, row);
        out
    }

    pub fn focus(focused: bool) -> Vec<u8> {
        vec![(KIND_FOCUS << 5) | u8::from(focused)]
    }
}

#[cfg(test)]
mod tests {
    use super::build::{self, Key};
    use super::*;

    const ENTER: u32 = 57345;
    const UP: u32 = 57352;

    #[test]
    fn a_plain_keystroke_is_two_bytes_with_its_text_implied() {
        let record = build::press('a');
        assert_eq!(record, [0x00, b'a']);
        assert_eq!(
            decode(&record),
            Some(InputRecord::Key(KeyRecord {
                event: KeyEvent::Press,
                key: u32::from('a'),
                mods: 0,
                shifted: None,
                base: None,
                text: KeyText::Implied('a'),
            }))
        );
        assert_eq!(build::functional(UP, 0, 0).len(), 2);
        assert_eq!(build::functional(ENTER, 2, 0).len(), 2);
    }

    #[test]
    fn shift_implies_the_shifted_text_and_suppressing_modifiers_imply_none() {
        let shifted = build::key(Key {
            key: u32::from('a'),
            mods: mods::SHIFT,
            shifted: Some(u32::from('A')),
            ..Key::default()
        });
        assert_eq!(shifted.len(), 5);
        let Some(InputRecord::Key(key)) = decode(&shifted) else {
            panic!("shifted key decodes");
        };
        assert_eq!(key.text, KeyText::Implied('A'));

        let ctrl = build::key(Key {
            key: u32::from('c'),
            mods: mods::CTRL,
            ..Key::default()
        });
        let Some(InputRecord::Key(key)) = decode(&ctrl) else {
            panic!("ctrl key decodes");
        };
        assert_eq!(key.text, KeyText::None);

        let explicit = build::key(Key {
            key: u32::from('a'),
            mods: mods::CAPS_LOCK,
            text: Some("A"),
            ..Key::default()
        });
        let Some(InputRecord::Key(key)) = decode(&explicit) else {
            panic!("explicit text decodes");
        };
        assert_eq!(key.text, KeyText::Explicit("A"));
    }

    #[test]
    fn produced_text_is_implied_when_the_key_implies_it_and_stated_otherwise() {
        let a = u32::from('a');
        let typing = |mods: u8, shifted: Option<u32>, produced: Option<&str>| {
            build::key_typing(
                Key {
                    key: a,
                    mods,
                    shifted,
                    ..Key::default()
                },
                produced,
            )
        };
        let text = |record: &[u8]| -> String {
            match decode(record) {
                Some(InputRecord::Key(key)) => format!("{:?}", key.text),
                other => panic!("a key record, got {other:?}"),
            }
        };
        assert_eq!(typing(0, None, Some("a")), build::press('a'));
        assert_eq!(
            text(&typing(mods::SHIFT, Some(u32::from('A')), Some("A"))),
            "Implied('A')"
        );
        // Caps Lock typed a capital the key does not imply.
        assert_eq!(
            text(&typing(mods::CAPS_LOCK, None, Some("A"))),
            "Explicit(\"A\")"
        );
        // A printable key that typed nothing says so; Ctrl implies nothing.
        assert_eq!(text(&typing(0, None, None)), "None");
        assert_eq!(
            typing(mods::CTRL, None, None),
            build::key(Key {
                key: a,
                mods: mods::CTRL,
                ..Key::default()
            })
        );
        // Text a suppressing modifier cannot imply is stated.
        assert_eq!(text(&typing(mods::ALT, None, Some("å"))), "Explicit(\"å\")");
    }

    #[test]
    fn every_other_kind_roundtrips() {
        assert_eq!(
            decode(&build::text("héllo\n")),
            Some(InputRecord::Text("héllo\n"))
        );
        assert_eq!(
            decode(&build::paste("a\x1bb")),
            Some(InputRecord::Paste("a\x1bb"))
        );
        assert_eq!(
            decode(&build::mouse(2, 3, mods::CTRL, 300, 7)),
            Some(InputRecord::Mouse(MouseRecord {
                action: MouseAction::Motion,
                button: MouseButton::None,
                mods: mods::CTRL,
                column: 300,
                row: 7,
            }))
        );
        assert_eq!(
            decode(&build::wheel(1, 0, 3, 0, 0)),
            Some(InputRecord::Wheel(WheelRecord {
                direction: WheelDirection::Down,
                mods: 0,
                count: 3,
                column: 0,
                row: 0,
            }))
        );
        assert_eq!(decode(&build::focus(true)), Some(InputRecord::Focus(true)));
        assert_eq!(
            decode(&build::focus(false)),
            Some(InputRecord::Focus(false))
        );
    }

    #[test]
    fn every_noncanonical_or_reserved_spelling_is_rejected() {
        let rejected: &[&[u8]] = &[
            &[],
            // Reserved kinds.
            &[6 << 5],
            &[7 << 5, 0],
            // Event 3 is not an event.
            &[3 << 3, b'a'],
            // A control character must be named by its functional key.
            &[0x00, 0x0d],
            &[0x00, 0x7f],
            // The functional block is reachable only by index.
            &[0x00, 0x80, 0xc0, 0x03],
            // Functional index past Kitty's table.
            &[KEY_HEAD_FN, 111],
            // Surrogate and out-of-range code points.
            &[0x00, 0x80, 0xb0, 0x03],
            &[0x00, 0x80, 0x80, 0xc4, 0x01],
            // Overlong LEB128: 'a' with a redundant zero group.
            &[0x00, 0xe1, 0x00],
            // Zero modifier and zero extension bytes.
            &[KEY_HEAD_MODS, b'a', 0],
            &[KEY_HEAD_EXT, b'a', 0],
            // Reserved extension bit, and text both explicit and absent.
            &[KEY_HEAD_EXT, b'a', 0x10],
            &[KEY_HEAD_EXT, b'a', EXT_TEXT | EXT_NO_TEXT],
            // Explicit text that is empty, carries a control code, or is not UTF-8.
            &[KEY_HEAD_EXT, b'a', EXT_TEXT],
            &[KEY_HEAD_EXT, b'a', EXT_TEXT, 0x1b],
            &[KEY_HEAD_EXT, b'a', EXT_TEXT, 0xff],
            // The text a key implies, spelled out: plain, and shifted.
            &[KEY_HEAD_EXT, b'a', EXT_TEXT, b'a'],
            &[
                KEY_HEAD_MODS | KEY_HEAD_EXT,
                b'a',
                mods::SHIFT,
                EXT_SHIFTED | EXT_TEXT,
                b'A',
                b'A',
            ],
            // "No text" where the key implies none already: a release, a
            // functional key, a text-suppressing modifier.
            &[(2 << 3) | KEY_HEAD_EXT, b'a', EXT_NO_TEXT],
            &[KEY_HEAD_FN | KEY_HEAD_EXT, 1, EXT_NO_TEXT],
            &[KEY_HEAD_MODS | KEY_HEAD_EXT, b'c', mods::CTRL, EXT_NO_TEXT],
            // Trailing bytes after a complete key.
            &[0x00, b'a', b'b'],
            // Empty or malformed text and paste, and reserved head bits.
            &[KIND_TEXT << 5],
            &[KIND_PASTE << 5, 0xc3],
            &[(KIND_TEXT << 5) | 1, b'a'],
            // A button-less press, an unknown button, a truncated position.
            &[KIND_MOUSE << 5, 3, 0, 0],
            &[KIND_MOUSE << 5, 4, 0, 0],
            &[KIND_MOUSE << 5, 0, 0],
            &[(KIND_MOUSE << 5) | (3 << 3), 0, 0, 0],
            // A wheel that turns zero notches.
            &[KIND_WHEEL << 5, 0, 0, 0],
            // Focus with reserved bits or a body.
            &[(KIND_FOCUS << 5) | 2],
            &[KIND_FOCUS << 5, 0],
        ];
        for bytes in rejected {
            assert!(!validate(bytes), "{bytes:02x?} must be rejected");
        }
    }
}
