//! The host terminal's input stream: keyboard reports and raw keys as input records,
//! and mouse, wheel and the host's replies as events for the TUI to route.
//!
//! The TUI requests every Kitty keyboard flag, SGR mouse reporting,
//! bracketed paste and focus reporting. Plain UTF-8 is committed text; raw
//! CR, BS/DEL and HT name Enter, Backspace and Tab. Other C0 bytes except ESC
//! name control-key presses, and each raw key ends the preceding text run.
//! A key's record states the host's own facts: the key, its shifted and base-layout
//! keys, its modifiers and event, and the text it typed, spelled as the browser spells
//! the same facts. Kitty keeps the legacy spellings `CSI 1;m A`, `CSI n ~` and
//! `CSI 13 u` for keys legacy terminals had; they map onto the functional-key
//! table records use. A sequence the TUI does not know is dropped whole.

use merkur_wire::input_record::{
    FUNCTIONAL_KEY_FIRST, FUNCTIONAL_KEY_LAST, MouseAction, MouseButton, MouseRecord,
    WheelDirection, WheelRecord, build, mods, validate,
};

use crate::sensitive::{append_bytes, push_char};
use zeroize::{Zeroize, Zeroizing};

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

/// Kitty's functional-key table, by index from `FUNCTIONAL_KEY_FIRST`.
pub(crate) mod functional {
    use super::FUNCTIONAL_KEY_FIRST;

    pub const ESCAPE: u32 = FUNCTIONAL_KEY_FIRST;
    pub const ENTER: u32 = FUNCTIONAL_KEY_FIRST + 1;
    pub const TAB: u32 = FUNCTIONAL_KEY_FIRST + 2;
    pub const BACKSPACE: u32 = FUNCTIONAL_KEY_FIRST + 3;
    pub const INSERT: u32 = FUNCTIONAL_KEY_FIRST + 4;
    pub const DELETE: u32 = FUNCTIONAL_KEY_FIRST + 5;
    pub const LEFT: u32 = FUNCTIONAL_KEY_FIRST + 6;
    pub const RIGHT: u32 = FUNCTIONAL_KEY_FIRST + 7;
    pub const UP: u32 = FUNCTIONAL_KEY_FIRST + 8;
    pub const DOWN: u32 = FUNCTIONAL_KEY_FIRST + 9;
    pub const PAGE_UP: u32 = FUNCTIONAL_KEY_FIRST + 10;
    pub const PAGE_DOWN: u32 = FUNCTIONAL_KEY_FIRST + 11;
    pub const HOME: u32 = FUNCTIONAL_KEY_FIRST + 12;
    pub const END: u32 = FUNCTIONAL_KEY_FIRST + 13;
    pub const MENU: u32 = FUNCTIONAL_KEY_FIRST + 19;
    /// F1 through F35 are consecutive.
    pub const F1: u32 = FUNCTIONAL_KEY_FIRST + 20;
    pub const KP_BEGIN: u32 = FUNCTIONAL_KEY_FIRST + 83;
}

#[derive(Debug, PartialEq, Eq)]
pub enum HostEvent {
    /// A key, committed text, a paste or a focus change, as its input record.
    Record(Vec<u8>),
    /// A mouse button or motion at a host cell, counted from zero.
    Mouse(MouseRecord),
    /// One wheel notch at a host cell, counted from zero.
    Wheel(WheelRecord),
    Reply(Reply),
}

impl Drop for HostEvent {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        match self {
            Self::Record(bytes)
            | Self::Reply(Reply::Osc(bytes) | Reply::Dcs(bytes) | Reply::Apc(bytes)) => {
                bytes.zeroize()
            }
            Self::Reply(Reply::Graphics {
                result: Err(message),
                ..
            }) => message.zeroize(),
            _ => {}
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
    /// `CSI 0 n`: the host consumed everything written before the request.
    Consumed,
    /// `CSI ? flags u`: the Kitty keyboard flags in force.
    KeyboardFlags(u32),
    /// `CSI 6 ; height ; width t`: one host cell in pixels.
    CellSize {
        width: u32,
        height: u32,
    },
    /// `CSI ? mode ; value $ y`: the state of a DEC private mode.
    Mode {
        mode: u32,
        value: u32,
    },
    /// `CSI ? … c`: primary device attributes, which every host answers.
    DeviceAttributes,
    /// The body of an OSC, DCS or APC string.
    Osc(Vec<u8>),
    Dcs(Vec<u8>),
    Apc(Vec<u8>),
    /// Kitty's acknowledgement of an image upload or placement.
    Graphics {
        image: u32,
        placement: Option<u32>,
        result: Result<(), String>,
    },
}

#[derive(Default)]
pub struct HostInput {
    /// Bytes of a sequence or character a read split.
    pending: Vec<u8>,
    /// The text of a paste still open.
    paste: Option<Vec<u8>>,
    /// The text a key typed, reused across keys.
    typed: String,
}

enum Step {
    /// This many bytes made one token, or were dropped.
    Consumed(usize),
    /// The token continues past what has arrived.
    Incomplete,
}

impl HostInput {
    /// Parses what the host wrote, appending one event per complete token.
    pub fn feed(&mut self, bytes: &[u8], out: &mut Vec<HostEvent>) {
        append_bytes(&mut self.pending, bytes);
        let mut at = 0;
        while at < self.pending.len() {
            let mut input = Zeroizing::new(std::mem::take(&mut self.pending));
            let step = self.step(&input[at..], out);
            self.pending = std::mem::take(&mut *input);
            match step {
                Step::Consumed(count) => at += count,
                Step::Incomplete => break,
            }
        }
        let retained = self.pending.len() - at;
        self.pending.copy_within(at.., 0);
        self.pending[retained..].zeroize();
        self.pending.truncate(retained);
        self.typed.zeroize();
    }

    /// Erase parser storage after collecting a secret. Capacity is wiped too:
    /// clearing a string alone would leave the preceding password in memory.
    pub fn clear_sensitive(&mut self) {
        use zeroize::Zeroize;
        self.pending.zeroize();
        if let Some(mut paste) = self.paste.take() {
            paste.zeroize();
        }
        self.typed.zeroize();
    }

    /// Wipe committed text without discarding an incomplete input token.
    pub fn clear_typed(&mut self) {
        use zeroize::Zeroize;
        self.typed.zeroize();
    }

    fn step(&mut self, input: &[u8], out: &mut Vec<HostEvent>) -> Step {
        if let Some(paste) = &mut self.paste {
            const END: &[u8] = b"\x1b[201~";
            // The end marker may be split across reads: hold back a tail that
            // could begin it.
            return match find(input, END) {
                Some(end) => {
                    append_bytes(paste, &input[..end]);
                    let text = zeroize::Zeroizing::new(self.paste.take().unwrap_or_default());
                    if let Ok(text) = std::str::from_utf8(&text)
                        && !text.is_empty()
                    {
                        out.push(HostEvent::Record(build::paste(text)));
                    }
                    Step::Consumed(end + END.len())
                }
                None => {
                    let keep = (1..END.len())
                        .rev()
                        .find(|len| input.ends_with(&END[..*len]))
                        .unwrap_or(0);
                    append_bytes(paste, &input[..input.len() - keep]);
                    if keep == input.len() {
                        Step::Incomplete
                    } else {
                        Step::Consumed(input.len() - keep)
                    }
                }
            };
        }
        if input[0] != ESC {
            if let Some((key, modifiers)) = raw_key(input[0]) {
                out.push(HostEvent::Record(build::functional(key, 0, modifiers)));
                return Step::Consumed(1);
            }
            return self.text(input, out);
        }
        let Some(&introducer) = input.get(1) else {
            return Step::Incomplete;
        };
        match introducer {
            b'[' => self.csi(input, out),
            b']' => string(input, true, Reply::Osc, out),
            b'P' => string(input, false, Reply::Dcs, out),
            b'_' => string(input, false, apc_reply, out),
            // An escape that opens no host report the TUI knows is dropped.
            _ => Step::Consumed(1),
        }
    }

    /// Committed text up to the next escape or raw key. C1 controls type nothing.
    fn text(&mut self, input: &[u8], out: &mut Vec<HostEvent>) -> Step {
        let end = input
            .iter()
            .position(|byte| *byte == ESC || raw_key(*byte).is_some())
            .unwrap_or(input.len());
        let run = &input[..end];
        let error = std::str::from_utf8(run).err();
        let valid = error.map_or(run.len(), |error| error.valid_up_to());
        let text = std::str::from_utf8(&run[..valid]).unwrap_or_default();
        if text.chars().any(|c| is_control(u32::from(c))) {
            self.typed.zeroize();
            for c in text.chars().filter(|c| !is_control(u32::from(*c))) {
                push_char(&mut self.typed, c);
            }
            if !self.typed.is_empty() {
                out.push(HostEvent::Record(build::text(&self.typed)));
            }
        } else if !text.is_empty() {
            out.push(HostEvent::Record(build::text(text)));
        }
        match error.map(|error| error.error_len()) {
            None => Step::Consumed(end),
            // A character a read split: wait for the rest of it.
            Some(None) if end == input.len() && valid == 0 => Step::Incomplete,
            Some(None) if end == input.len() => Step::Consumed(valid),
            // One an escape cut short, or bytes that are not UTF-8: dropped.
            Some(None) => Step::Consumed(end),
            Some(Some(bad)) => Step::Consumed(valid + bad),
        }
    }

    fn csi(&mut self, input: &[u8], out: &mut Vec<HostEvent>) -> Step {
        let body = &input[2..];
        let Some(end) = body.iter().position(|byte| (0x40..=0x7e).contains(byte)) else {
            return if body.iter().all(|byte| (0x20..=0x3f).contains(byte)) {
                Step::Incomplete
            } else {
                Step::Consumed(2)
            };
        };
        let final_byte = body[end];
        let (params, intermediates) = split_intermediates(&body[..end]);
        let consumed = Step::Consumed(2 + end + 1);
        let Ok(params) = std::str::from_utf8(params) else {
            return consumed;
        };
        if let Some(event) = self.dispatch(params, intermediates, final_byte) {
            out.push(event);
        }
        consumed
    }

    fn dispatch(
        &mut self,
        params: &str,
        intermediates: &[u8],
        final_byte: u8,
    ) -> Option<HostEvent> {
        match (params.as_bytes().first(), intermediates, final_byte) {
            (Some(b'?'), [], b'u') => Some(HostEvent::Reply(Reply::KeyboardFlags(
                params[1..].parse().ok()?,
            ))),
            (Some(b'?'), [], b'c') => Some(HostEvent::Reply(Reply::DeviceAttributes)),
            (Some(b'?'), [b'$'], b'y') => {
                let (mode, value) = params[1..].split_once(';')?;
                Some(HostEvent::Reply(Reply::Mode {
                    mode: mode.parse().ok()?,
                    value: value.parse().ok()?,
                }))
            }
            (Some(b'<'), [], b'M' | b'm') => mouse(&params[1..], final_byte == b'm'),
            (_, [], b't') => {
                let mut fields = params.split(';');
                if fields.next()? != "6" {
                    return None;
                }
                let height = fields.next()?.parse().ok()?;
                let width = fields.next()?.parse().ok()?;
                (fields.next().is_none() && width > 0 && height > 0)
                    .then_some(HostEvent::Reply(Reply::CellSize { width, height }))
            }
            (_, [], b'n') if params == "0" => Some(HostEvent::Reply(Reply::Consumed)),
            (_, [], b'I') if params.is_empty() => Some(HostEvent::Record(build::focus(true))),
            (_, [], b'O') if params.is_empty() => Some(HostEvent::Record(build::focus(false))),
            (_, [], b'~') if params == "200" => {
                self.paste = Some(Vec::new());
                None
            }
            (Some(b'0'..=b'9') | None, [], b'u') => self.kitty_key(params),
            (Some(b'0'..=b'9') | None, [], b'~') => {
                let (number, modifiers) = params.split_once(';').unwrap_or((params, ""));
                let key = tilde_key(number.parse().ok()?)?;
                self.key(key, None, None, modifiers, None)
            }
            (Some(b'0'..=b'9') | None, [], b'A'..=b'S') => {
                let key = letter_key(final_byte)?;
                let modifiers = match params.split_once(';') {
                    Some(("1", modifiers)) => modifiers,
                    None if params.is_empty() => "",
                    _ => return None,
                };
                self.key(key, None, None, modifiers, None)
            }
            _ => None,
        }
    }

    /// `CSI key[:shifted[:base]] [; mods[:event] [; text]] u`.
    fn kitty_key(&mut self, params: &str) -> Option<HostEvent> {
        let mut fields = params.split(';');
        let mut identity = fields.next().unwrap_or("").split(':');
        let code: u32 = identity.next()?.parse().ok()?;
        let shifted = optional_number(identity.next())?;
        let base = optional_number(identity.next())?;
        let modifiers = fields.next().unwrap_or("");
        let text = fields.next();
        if identity.next().is_some() || fields.next().is_some() {
            return None;
        }
        // A key the host cannot name that typed text is committed text.
        if code == 0 {
            let text = self.decode_text(text?)?;
            return Some(HostEvent::Record(build::text(text)));
        }
        let key = match code {
            27 => functional::ESCAPE,
            13 => functional::ENTER,
            9 => functional::TAB,
            127 => functional::BACKSPACE,
            code if is_control(code) => return None,
            code => code,
        };
        self.key(key, shifted, base, modifiers, text)
    }

    /// Kitty's text field, code points separated by colons.
    fn decode_text(&mut self, text: &str) -> Option<&str> {
        self.typed.zeroize();
        for code in text.split(':') {
            let c = char::from_u32(code.parse().ok()?)?;
            if is_control(u32::from(c)) {
                return None;
            }
            push_char(&mut self.typed, c);
        }
        Some(&self.typed)
    }

    fn key(
        &mut self,
        key: u32,
        shifted: Option<u32>,
        base: Option<u32>,
        modifiers: &str,
        text: Option<&str>,
    ) -> Option<HostEvent> {
        let (mods, event) = modifiers_and_event(modifiers)?;
        let produced = match text {
            Some(text) => Some(self.decode_text(text)?),
            None => None,
        };
        let record = build::key_typing(
            build::Key {
                event,
                key,
                mods,
                shifted,
                base,
                text: None,
            },
            produced,
        );
        validate(&record).then_some(HostEvent::Record(record))
    }
}

/// Traditional host key spellings. These bytes carry no release, repeat or
/// layout facts; their conventional key identity is all the host supplied.
fn raw_key(byte: u8) -> Option<(u32, u8)> {
    Some(match byte {
        b'\r' => (functional::ENTER, 0),
        b'\t' => (functional::TAB, 0),
        0x08 | 0x7f => (functional::BACKSPACE, 0),
        0 => (u32::from(' '), mods::CTRL),
        1..=26 => (u32::from(b'a' + byte - 1), mods::CTRL),
        0x1c..=0x1f => (u32::from(b'\\' + byte - 0x1c), mods::CTRL),
        _ => return None,
    })
}

impl Drop for HostInput {
    fn drop(&mut self) {
        self.clear_sensitive();
    }
}

/// `mods[:event]`: Kitty sends one plus the modifier bits, and the event as
/// 1 press, 2 repeat, 3 release. Either may be absent.
fn modifiers_and_event(field: &str) -> Option<(u8, u8)> {
    let (mods, event) = field.split_once(':').unwrap_or((field, ""));
    let mods: u32 = if mods.is_empty() {
        1
    } else {
        mods.parse().ok()?
    };
    let event: u8 = if event.is_empty() {
        1
    } else {
        event.parse().ok()?
    };
    if !(1..=3).contains(&event) {
        return None;
    }
    Some((u8::try_from(mods.checked_sub(1)?).ok()?, event - 1))
}

fn optional_number(field: Option<&str>) -> Option<Option<u32>> {
    match field {
        None | Some("") => Some(None),
        Some(number) => number.parse().ok().map(Some),
    }
}

/// `CSI number ~` keys.
fn tilde_key(number: u32) -> Option<u32> {
    Some(match number {
        2 => functional::INSERT,
        3 => functional::DELETE,
        5 => functional::PAGE_UP,
        6 => functional::PAGE_DOWN,
        7 => functional::HOME,
        8 => functional::END,
        11..=15 => functional::F1 + number - 11,
        17..=21 => functional::F1 + number - 12,
        23 | 24 => functional::F1 + number - 13,
        29 => functional::MENU,
        _ => return None,
    })
}

/// `CSI 1;m X` keys. F3 is `CSI 13 ~`, since `CSI R` is a cursor report.
fn letter_key(final_byte: u8) -> Option<u32> {
    Some(match final_byte {
        b'A' => functional::UP,
        b'B' => functional::DOWN,
        b'C' => functional::RIGHT,
        b'D' => functional::LEFT,
        b'E' => functional::KP_BEGIN,
        b'F' => functional::END,
        b'H' => functional::HOME,
        b'P' => functional::F1,
        b'Q' => functional::F1 + 1,
        b'S' => functional::F1 + 3,
        _ => return None,
    })
}

/// `CSI < button ; column ; row M|m`, one-based.
fn mouse(params: &str, release: bool) -> Option<HostEvent> {
    let mut fields = params.split(';').map(str::parse::<u32>);
    let code = fields.next()?.ok()?;
    let column = fields.next()?.ok()?.checked_sub(1)?;
    let row = fields.next()?.ok()?.checked_sub(1)?;
    if fields.next().is_some() {
        return None;
    }
    let mut record_mods = 0;
    if code & 4 != 0 {
        record_mods |= mods::SHIFT;
    }
    if code & 8 != 0 {
        record_mods |= mods::ALT;
    }
    if code & 16 != 0 {
        record_mods |= mods::CTRL;
    }
    // Buttons past the wheel have no record.
    if code & 128 != 0 {
        return None;
    }
    if code & 64 != 0 {
        if release {
            return None;
        }
        let direction = match code & 3 {
            0 => WheelDirection::Up,
            1 => WheelDirection::Down,
            2 => WheelDirection::Left,
            _ => WheelDirection::Right,
        };
        return Some(HostEvent::Wheel(WheelRecord {
            direction,
            mods: record_mods,
            count: 1,
            column,
            row,
        }));
    }
    let button = match code & 3 {
        0 => MouseButton::Left,
        1 => MouseButton::Middle,
        2 => MouseButton::Right,
        _ => MouseButton::None,
    };
    let action = if code & 32 != 0 {
        MouseAction::Motion
    } else if release {
        MouseAction::Release
    } else {
        MouseAction::Press
    };
    // Only motion happens with no button held.
    if button == MouseButton::None && action != MouseAction::Motion {
        return None;
    }
    Some(HostEvent::Mouse(MouseRecord {
        action,
        button,
        mods: record_mods,
        column,
        row,
    }))
}

/// An OSC (ended by BEL or ST), DCS or APC (ended by ST) string's body.
fn string(
    input: &[u8],
    bel_ends: bool,
    reply: fn(Vec<u8>) -> Reply,
    out: &mut Vec<HostEvent>,
) -> Step {
    let body = &input[2..];
    for (at, byte) in body.iter().enumerate() {
        if bel_ends && *byte == BEL {
            out.push(HostEvent::Reply(reply(body[..at].to_vec())));
            return Step::Consumed(2 + at + 1);
        }
        if *byte == ESC {
            return match body.get(at + 1) {
                Some(b'\\') => {
                    out.push(HostEvent::Reply(reply(body[..at].to_vec())));
                    Step::Consumed(2 + at + 2)
                }
                Some(_) => Step::Consumed(2 + at),
                None => Step::Incomplete,
            };
        }
    }
    Step::Incomplete
}

/// Parameter bytes, then intermediate bytes (`0x20..=0x2f`).
fn split_intermediates(bytes: &[u8]) -> (&[u8], &[u8]) {
    let split = bytes
        .iter()
        .position(|byte| (0x20..=0x2f).contains(byte))
        .unwrap_or(bytes.len());
    bytes.split_at(split)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn is_control(code: u32) -> bool {
    code < 0x20 || (0x7f..=0x9f).contains(&code)
}

const _: () = assert!(functional::KP_BEGIN <= FUNCTIONAL_KEY_LAST);

#[cfg(test)]
mod tests;

fn apc_reply(body: Vec<u8>) -> Reply {
    let parsed = || {
        let body = std::str::from_utf8(&body).ok()?.strip_prefix('G')?;
        let (fields, message) = body.split_once(';')?;
        if message.is_empty() || !message.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
            return None;
        }
        let mut image = None;
        let mut placement = None;
        for field in fields.split(',') {
            let (key, value) = field.split_once('=')?;
            if !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let value: u32 = value.parse().ok()?;
            if value == 0 {
                return None;
            }
            match key {
                "i" if image.is_none() => image = Some(value),
                "p" if placement.is_none() => placement = Some(value),
                _ => return None,
            }
        }
        Some(Reply::Graphics {
            image: image?,
            placement,
            result: if message == "OK" {
                Ok(())
            } else {
                Err(message.to_owned())
            },
        })
    };
    parsed().unwrap_or(Reply::Apc(body))
}
