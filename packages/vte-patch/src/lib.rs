//! Parser for implementing virtual terminal emulators
//!
//! [`Parser`] is implemented according to [Paul Williams' ANSI parser state
//! machine]. The state machine doesn't assign meaning to the parsed data and is
//! thus not itself sufficient for writing a terminal emulator. Instead, it is
//! expected that an implementation of [`Perform`] is provided which does
//! something useful with the parsed data. The [`Parser`] handles the book
//! keeping, and the [`Perform`] gets to simply handle actions.
//!
//! # Examples
//!
//! For an example of using the [`Parser`] please see the examples folder. The
//! example included there simply logs all the actions [`Perform`] does. One
//! quick way to see it in action is to pipe `printf` into it
//!
//! ```sh
//! printf '\x1b[31mExample' | cargo run --example parselog
//! ```
//!
//! # Differences from original state machine description
//!
//! * UTF-8 Support for Input
//! * OSC Strings can be terminated by 0x07
//! * Only supports 7-bit codes
//!
//! [`Parser`]: struct.Parser.html
//! [`Perform`]: trait.Perform.html
//! [Paul Williams' ANSI parser state machine]: https://vt100.net/emu/dec_ansi_parser
#![deny(clippy::all, clippy::if_not_else, clippy::enum_glob_use)]
#![cfg_attr(not(feature = "std"), no_std)]

use core::mem::MaybeUninit;
use core::str;

#[cfg(not(feature = "std"))]
use arrayvec::ArrayVec;

mod params;

#[cfg(feature = "ansi")]
pub mod ansi;
pub use params::{Params, ParamsIter};

const MAX_INTERMEDIATES: usize = 2;
const MAX_OSC_PARAMS: usize = 16;
const MAX_OSC_RAW: usize = 1024;
/// Bound the standard-library OSC accumulator, including base64 clipboard copies.
#[cfg(feature = "std")]
const MAX_OSC_STRING_BYTES: usize = 4 * 1024 * 1024;

/// Erase OSC storage before reuse, reallocation or retirement. Volatile stores
/// keep clipboard text erasure observable to the compiler without raising MSRV.
fn erase_osc(bytes: &mut [u8]) {
    for byte in bytes {
        // SAFETY: Each pointer is exclusively borrowed, live and aligned for u8.
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
    core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
}

/// The APC payload prefix: everything before CAN, SUB or ESC. Out of line so
/// its SIMD constants never compete for registers with the advance loop.
#[inline(never)]
fn apc_payload_len(bytes: &[u8]) -> usize {
    memchr::memchr3(0x18, 0x1A, 0x1B, bytes).unwrap_or(bytes.len())
}

/// Ordinary OSC payload: the bytes sent to action_osc_put by the byte table.
fn osc_payload_len(bytes: &[u8]) -> usize {
    let mut offset = 0;
    for block in bytes.chunks_exact(16) {
        let stop = block.iter().fold(false, |any, &b| any | (b < 0x20) | (b == b';'));
        if stop {
            break;
        }
        offset += 16;
    }
    offset
        + bytes[offset..]
            .iter()
            .position(|&b| b < 0x20 || b == b';')
            .unwrap_or(bytes.len() - offset)
}

/// The printable ASCII prefix, classified a block at a time.
fn printable_ascii_len(bytes: &[u8]) -> usize {
    // Short runs dominate shell and TUI text: look at the first bytes one by
    // one before paying for whole blocks.
    let head = bytes.len().min(8);
    if let Some(stop) = bytes[..head].iter().position(|&b| b.wrapping_sub(0x20) > 0x5E) {
        return stop;
    }
    let mut offset = head;
    for block in bytes[head..].chunks_exact(16) {
        let stop = block.iter().fold(false, |any, &b| any | (b.wrapping_sub(0x20) > 0x5E));
        if stop {
            break;
        }
        offset += 16;
    }
    offset
        + bytes[offset..]
            .iter()
            .position(|&b| b.wrapping_sub(0x20) > 0x5E)
            .unwrap_or(bytes.len() - offset)
}

/// The text prefix: everything before the next C0 control (ESC included).
fn text_len(bytes: &[u8]) -> usize {
    let head = bytes.len().min(8);
    if let Some(stop) = bytes[..head].iter().position(|&b| b < 0x20) {
        return stop;
    }
    let mut offset = head;
    for block in bytes[head..].chunks_exact(16) {
        let stop = block.iter().fold(false, |any, &b| any | (b < 0x20));
        if stop {
            break;
        }
        offset += 16;
    }
    offset + bytes[offset..].iter().position(|&b| b < 0x20).unwrap_or(bytes.len() - offset)
}

/// Parser for raw _VTE_ protocol which delegates actions to a [`Perform`]
///
/// [`Perform`]: trait.Perform.html
///
/// Generic over the value for the size of the raw Operating System Command
/// buffer. Only used when the `std` feature is not enabled.
#[derive(Default)]
pub struct Parser<const OSC_RAW_BUF_SIZE: usize = MAX_OSC_RAW> {
    state: State,
    intermediates: [u8; MAX_INTERMEDIATES],
    intermediate_idx: usize,
    params: Params,
    param: u16,
    #[cfg(not(feature = "std"))]
    osc_raw: ArrayVec<u8, OSC_RAW_BUF_SIZE>,
    #[cfg(feature = "std")]
    osc_raw: Vec<u8>,
    osc_params: [(usize, usize); MAX_OSC_PARAMS],
    osc_num_params: usize,
    ignoring: bool,
    partial_utf8: [u8; 4],
    partial_utf8_len: usize,
}

impl Parser {
    /// Create a new Parser
    pub fn new() -> Parser {
        Default::default()
    }
}

impl<const OSC_RAW_BUF_SIZE: usize> Parser<OSC_RAW_BUF_SIZE> {
    /// An unfinished control must not be mistaken for current shell evidence.
    pub fn control_pending(&self) -> bool {
        self.state != State::Ground
    }
    /// Create a new Parser with a custom size for the Operating System Command
    /// buffer.
    ///
    /// Call with a const-generic param on `Parser`, like:
    ///
    /// ```rust
    /// let mut p = vte::Parser::<64>::new_with_size();
    /// ```
    #[cfg(not(feature = "std"))]
    pub fn new_with_size() -> Parser<OSC_RAW_BUF_SIZE> {
        Default::default()
    }

    #[inline]
    fn params(&self) -> &Params {
        &self.params
    }

    #[inline]
    fn start_escape<P: Perform>(&mut self, performer: &mut P) {
        self.reset_params();
        performer.control_started();
        self.state = State::Escape;
    }

    #[inline]
    fn intermediates(&self) -> &[u8] {
        &self.intermediates[..self.intermediate_idx]
    }

    /// Advance the parser state.
    ///
    /// Requires a [`Perform`] implementation to handle the triggered actions.
    ///
    /// [`Perform`]: trait.Perform.html
    #[inline]
    pub fn advance<P: Perform>(&mut self, performer: &mut P, bytes: &[u8]) {
        let mut i = 0;

        // Handle partial codepoints from previous calls to `advance`.
        if self.partial_utf8_len != 0 {
            i += self.advance_partial_utf8(performer, bytes);
        } else if self.state == State::OscString {
            i += self.advance_osc_string(performer, bytes);
        }

        while i != bytes.len() {
            match self.state {
                State::Ground => i += self.advance_ground(performer, &bytes[i..]),
                State::ApcString => i += self.advance_apc_string(performer, &bytes[i..]),
                _ => {
                    // Inlining it results in worse codegen.
                    let byte = bytes[i];
                    self.change_state(performer, byte);
                    i += 1;
                },
            }
        }
    }

    /// Partially advance the parser state.
    ///
    /// This is equivalent to [`Self::advance`], but stops when
    /// [`Perform::terminated`] is true after reading a byte.
    ///
    /// Returns the number of bytes read before termination.
    ///
    /// See [`Perform::advance`] for more details.
    #[inline]
    #[must_use = "Returned value should be used to processs the remaining bytes"]
    pub fn advance_until_terminated<P: Perform>(
        &mut self,
        performer: &mut P,
        bytes: &[u8],
    ) -> usize {
        let mut i = 0;

        // Handle partial codepoints from previous calls to `advance`.
        if self.partial_utf8_len != 0 {
            i += self.advance_partial_utf8(performer, bytes);
        } else if self.state == State::OscString {
            i += self.advance_osc_string(performer, bytes);
        }

        while i != bytes.len() && !performer.terminated() {
            match self.state {
                State::Ground => i += self.advance_ground(performer, &bytes[i..]),
                State::ApcString => i += self.advance_apc_string(performer, &bytes[i..]),
                _ => {
                    // Inlining it results in worse codegen.
                    let byte = bytes[i];
                    self.change_state(performer, byte);
                    i += 1;
                },
            }
        }

        i
    }

    #[inline(always)]
    fn change_state<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        performer.observe_application_bytes(core::slice::from_ref(&byte));
        match self.state {
            State::CsiEntry => self.advance_csi_entry(performer, byte),
            State::CsiIgnore => self.advance_csi_ignore(performer, byte),
            State::CsiIntermediate => self.advance_csi_intermediate(performer, byte),
            State::CsiParam => self.advance_csi_param(performer, byte),
            State::DcsEntry => self.advance_dcs_entry(performer, byte),
            State::DcsIgnore => self.anywhere(performer, byte),
            State::DcsIntermediate => self.advance_dcs_intermediate(performer, byte),
            State::DcsParam => self.advance_dcs_param(performer, byte),
            State::DcsPassthrough => self.advance_dcs_passthrough(performer, byte),
            State::Escape => self.advance_esc(performer, byte),
            State::EscapeIntermediate => self.advance_esc_intermediate(performer, byte),
            State::OscString => self.advance_osc_string_byte(performer, byte),
            State::OscEscape => self.advance_osc_escape(performer, byte),
            State::SosPmString => self.anywhere(performer, byte),
            State::ApcEscape => self.advance_apc_escape(performer, byte),
            State::Ground | State::ApcString => unreachable!(),
        }
    }

    #[inline(always)]
    fn advance_csi_entry<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x17 | 0x19 | 0x1C..=0x1F => performer.execute(byte),
            0x20..=0x2F => {
                self.action_collect(byte);
                self.state = State::CsiIntermediate
            },
            0x30..=0x39 => {
                self.action_paramnext(byte);
                self.state = State::CsiParam
            },
            0x3A => {
                self.action_subparam();
                self.state = State::CsiParam
            },
            0x3B => {
                self.action_param();
                self.state = State::CsiParam
            },
            0x3C..=0x3F => {
                self.action_collect(byte);
                self.state = State::CsiParam
            },
            0x40..=0x7E => self.action_csi_dispatch(performer, byte),
            _ => self.anywhere(performer, byte),
        }
    }

    #[inline(always)]
    fn advance_csi_ignore<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x17 | 0x19 | 0x1C..=0x1F => performer.execute(byte),
            0x20..=0x3F => (),
            0x40..=0x7E => self.state = State::Ground,
            0x7F => (),
            _ => self.anywhere(performer, byte),
        }
    }

    #[inline(always)]
    fn advance_csi_intermediate<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x17 | 0x19 | 0x1C..=0x1F => performer.execute(byte),
            0x20..=0x2F => self.action_collect(byte),
            0x30..=0x3F => self.state = State::CsiIgnore,
            0x40..=0x7E => self.action_csi_dispatch(performer, byte),
            _ => self.anywhere(performer, byte),
        }
    }

    #[inline(always)]
    fn advance_csi_param<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x17 | 0x19 | 0x1C..=0x1F => performer.execute(byte),
            0x20..=0x2F => {
                self.action_collect(byte);
                self.state = State::CsiIntermediate
            },
            0x30..=0x39 => self.action_paramnext(byte),
            0x3A => self.action_subparam(),
            0x3B => self.action_param(),
            0x3C..=0x3F => self.state = State::CsiIgnore,
            0x40..=0x7E => self.action_csi_dispatch(performer, byte),
            0x7F => (),
            _ => self.anywhere(performer, byte),
        }
    }

    #[inline(always)]
    fn advance_dcs_entry<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x17 | 0x19 | 0x1C..=0x1F => (),
            0x20..=0x2F => {
                self.action_collect(byte);
                self.state = State::DcsIntermediate
            },
            0x30..=0x39 => {
                self.action_paramnext(byte);
                self.state = State::DcsParam
            },
            0x3A => {
                self.action_subparam();
                self.state = State::DcsParam
            },
            0x3B => {
                self.action_param();
                self.state = State::DcsParam
            },
            0x3C..=0x3F => {
                self.action_collect(byte);
                self.state = State::DcsParam
            },
            0x40..=0x7E => self.action_hook(performer, byte),
            0x7F => (),
            _ => self.anywhere(performer, byte),
        }
    }

    #[inline(always)]
    fn advance_dcs_intermediate<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x17 | 0x19 | 0x1C..=0x1F => (),
            0x20..=0x2F => self.action_collect(byte),
            0x30..=0x3F => self.state = State::DcsIgnore,
            0x40..=0x7E => self.action_hook(performer, byte),
            0x7F => (),
            _ => self.anywhere(performer, byte),
        }
    }

    #[inline(always)]
    fn advance_dcs_param<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x17 | 0x19 | 0x1C..=0x1F => (),
            0x20..=0x2F => {
                self.action_collect(byte);
                self.state = State::DcsIntermediate
            },
            0x30..=0x39 => self.action_paramnext(byte),
            0x3A => self.action_subparam(),
            0x3B => self.action_param(),
            0x3C..=0x3F => self.state = State::DcsIgnore,
            0x40..=0x7E => self.action_hook(performer, byte),
            0x7F => (),
            _ => self.anywhere(performer, byte),
        }
    }

    #[inline(always)]
    fn advance_dcs_passthrough<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x17 | 0x19 | 0x1C..=0x7E => performer.put(byte),
            0x18 | 0x1A => {
                performer.unhook();
                performer.control_cancelled();
                performer.execute(byte);
                self.state = State::Ground
            },
            0x1B => {
                performer.unhook();
                self.start_escape(performer);
            },
            0x7F => (),
            0x9C => {
                performer.unhook();
                self.state = State::Ground
            },
            _ => (),
        }
    }

    #[inline(always)]
    fn advance_esc<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x17 | 0x19 | 0x1C..=0x1F => performer.execute(byte),
            0x20..=0x2F => {
                self.action_collect(byte);
                self.state = State::EscapeIntermediate
            },
            0x30..=0x4F => {
                performer.esc_dispatch(self.intermediates(), self.ignoring, byte);
                self.state = State::Ground
            },
            0x50 => {
                self.reset_params();
                self.state = State::DcsEntry
            },
            0x51..=0x57 => {
                performer.esc_dispatch(self.intermediates(), self.ignoring, byte);
                self.state = State::Ground
            },
            0x58 => self.state = State::SosPmString,
            0x59..=0x5A => {
                performer.esc_dispatch(self.intermediates(), self.ignoring, byte);
                self.state = State::Ground
            },
            0x5B => {
                self.reset_params();
                self.state = State::CsiEntry
            },
            0x5C => {
                performer.esc_dispatch(self.intermediates(), self.ignoring, byte);
                self.state = State::Ground
            },
            0x5D => self.osc_start(),
            0x5E => self.state = State::SosPmString,
            0x5F => {
                self.state = State::ApcString;
                performer.apc_start();
            },
            0x60..=0x7E => {
                performer.esc_dispatch(self.intermediates(), self.ignoring, byte);
                self.state = State::Ground
            },
            // Anywhere.
            0x18 | 0x1A => {
                performer.control_cancelled();
                performer.execute(byte);
                self.state = State::Ground
            },
            0x1B => self.start_escape(performer),
            _ => (),
        }
    }

    /// APC contents stay borrowed and opaque. Neither the parser nor a generic
    /// terminal handler needs an allocation proportional to an image payload.
    #[inline]
    fn advance_apc_string<P: Perform>(&mut self, performer: &mut P, bytes: &[u8]) -> usize {
        let end = apc_payload_len(bytes);
        if end != 0 {
            performer.observe_application_bytes(&bytes[..end]);
            performer.apc_put(&bytes[..end]);
        }
        if end == bytes.len() {
            return end;
        }

        let byte = bytes[end];
        performer.observe_application_bytes(core::slice::from_ref(&byte));
        if byte == 0x1B {
            // ESC alone is not a successful terminator. Keep ownership of the
            // APC until the next byte distinguishes ST from cancellation.
            self.state = State::ApcEscape;
        } else {
            self.state = State::Ground;
            performer.apc_end(false);
            performer.control_cancelled();
            performer.execute(byte);
        }
        end + 1
    }

    #[inline]
    fn advance_apc_escape<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        if byte == b'\\' {
            self.state = State::Ground;
            performer.apc_end(true);
        } else {
            performer.apc_end(false);
            performer.control_cancelled();
            self.start_escape(performer);
            // The byte has already been observed by change_state. Dispatch it
            // in Escape directly, without observing or consuming it twice.
            self.advance_esc(performer, byte);
        }
    }

    #[inline(always)]
    fn advance_esc_intermediate<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x17 | 0x19 | 0x1C..=0x1F => performer.execute(byte),
            0x20..=0x2F => self.action_collect(byte),
            0x30..=0x7E => {
                performer.esc_dispatch(self.intermediates(), self.ignoring, byte);
                self.state = State::Ground
            },
            0x7F => (),
            _ => self.anywhere(performer, byte),
        }
    }

    #[inline(always)]
    fn advance_osc_string_byte<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x00..=0x06 | 0x08..=0x17 | 0x19 | 0x1C..=0x1F => (),
            0x07 => {
                self.osc_end(performer, byte);
                self.state = State::Ground
            },
            0x18 | 0x1A => {
                performer.control_cancelled();
                erase_osc(self.osc_raw.as_mut_slice());
                self.osc_raw.clear();
                self.osc_num_params = 0;
                performer.execute(byte);
                self.state = State::Ground
            },
            0x1B => self.state = State::OscEscape,
            0x3B => {
                #[cfg(not(feature = "std"))]
                {
                    if self.osc_raw.is_full() {
                        return;
                    }
                }
                // Preserve the rest of the final parameter, including its
                // separators. Consumers with a text body must not receive a
                // truncated notification or URL at the parameter-array bound.
                if self.osc_num_params == MAX_OSC_PARAMS - 1 {
                    self.action_osc_put(byte);
                } else {
                    self.action_osc_put_param();
                }
            },
            _ => self.action_osc_put(byte),
        }
    }

    #[inline]
    fn advance_osc_escape<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        if byte == b'\\' {
            self.osc_end(performer, 0x1b);
            self.reset_params();
            // Keep the existing canonical prompt-terminator callback, but only
            // after the complete ST has authenticated the OSC boundary.
            performer.control_started();
            performer.esc_dispatch(self.intermediates(), false, byte);
            self.state = State::Ground;
        } else {
            performer.control_cancelled();
            erase_osc(self.osc_raw.as_mut_slice());
            self.osc_raw.clear();
            self.osc_num_params = 0;
            self.start_escape(performer);
            self.advance_esc(performer, byte);
        }
    }

    #[inline(always)]
    fn anywhere<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        match byte {
            0x18 | 0x1A => {
                performer.control_cancelled();
                performer.execute(byte);
                self.state = State::Ground
            },
            0x1B => {
                performer.control_cancelled();
                self.start_escape(performer);
            },
            _ => (),
        }
    }

    #[inline]
    fn action_csi_dispatch<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        if self.params.is_full() {
            self.ignoring = true;
        } else {
            self.params.push(self.param);
        }
        performer.csi_dispatch(self.params(), self.intermediates(), self.ignoring, byte as char);

        self.state = State::Ground
    }

    #[inline]
    fn action_hook<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        if self.params.is_full() {
            self.ignoring = true;
        } else {
            self.params.push(self.param);
        }
        performer.hook(self.params(), self.intermediates(), self.ignoring, byte as char);
        self.state = State::DcsPassthrough;
    }

    #[inline]
    fn action_collect(&mut self, byte: u8) {
        if self.intermediate_idx == MAX_INTERMEDIATES {
            self.ignoring = true;
        } else {
            self.intermediates[self.intermediate_idx] = byte;
            self.intermediate_idx += 1;
        }
    }

    /// Advance to the next subparameter.
    #[inline]
    fn action_subparam(&mut self) {
        if self.params.is_full() {
            self.ignoring = true;
        } else {
            self.params.extend(self.param);
            self.param = 0;
        }
    }

    /// Advance to the next parameter.
    #[inline]
    fn action_param(&mut self) {
        if self.params.is_full() {
            self.ignoring = true;
        } else {
            self.params.push(self.param);
            self.param = 0;
        }
    }

    /// Advance inside the parameter without terminating it.
    #[inline]
    fn action_paramnext(&mut self, byte: u8) {
        if self.params.is_full() {
            self.ignoring = true;
        } else {
            // Continue collecting bytes into param.
            self.param = self.param.saturating_mul(10);
            self.param = self.param.saturating_add((byte - b'0') as u16);
        }
    }

    /// Add OSC param separator.
    #[inline]
    fn action_osc_put_param(&mut self) {
        let idx = self.osc_raw.len();

        let param_idx = self.osc_num_params;
        match param_idx {
            // First param is special - 0 to current byte index.
            0 => self.osc_params[param_idx] = (0, idx),

            // Only process up to MAX_OSC_PARAMS.
            MAX_OSC_PARAMS => return,

            // All other params depend on previous indexing.
            _ => {
                let prev = self.osc_params[param_idx - 1];
                let begin = prev.1;
                self.osc_params[param_idx] = (begin, idx);
            },
        }

        self.osc_num_params += 1;
    }

    #[inline(always)]
    fn action_osc_put(&mut self, byte: u8) {
        #[cfg(feature = "std")]
        if self.osc_raw.len() == MAX_OSC_STRING_BYTES {
            self.ignoring = true;
            return;
        }
        #[cfg(not(feature = "std"))]
        {
            if self.osc_raw.is_full() {
                self.ignoring = true;
                return;
            }
        }
        #[cfg(feature = "std")]
        if self.osc_raw.len() == self.osc_raw.capacity() {
            // Vec::push would free the previous allocation without erasing it.
            let capacity = self.osc_raw.capacity().max(64) * 2;
            let mut next = Vec::with_capacity(capacity.min(MAX_OSC_STRING_BYTES));
            next.extend_from_slice(&self.osc_raw);
            erase_osc(self.osc_raw.as_mut_slice());
            self.osc_raw = next;
        }
        self.osc_raw.push(byte);
    }

    fn action_osc_put_slice(&mut self, bytes: &[u8]) {
        #[cfg(feature = "std")]
        {
            let room = MAX_OSC_STRING_BYTES - self.osc_raw.len();
            let take = room.min(bytes.len());
            if take != bytes.len() {
                self.ignoring = true;
            }
            let len = self.osc_raw.len() + take;
            if len > self.osc_raw.capacity() {
                // Reach the byte-at-a-time doubling capacity in one allocation,
                // erasing the previous allocation before it is freed.
                let mut capacity = self.osc_raw.capacity();
                while capacity < len {
                    capacity = (capacity.max(64) * 2).min(MAX_OSC_STRING_BYTES);
                }
                let mut next = Vec::with_capacity(capacity);
                next.extend_from_slice(&self.osc_raw);
                erase_osc(self.osc_raw.as_mut_slice());
                self.osc_raw = next;
            }
            self.osc_raw.extend_from_slice(&bytes[..take]);
        }
        #[cfg(not(feature = "std"))]
        {
            let take = self.osc_raw.remaining_capacity().min(bytes.len());
            if take != bytes.len() {
                self.ignoring = true;
            }
            let result = self.osc_raw.try_extend_from_slice(&bytes[..take]);
            debug_assert!(result.is_ok());
        }
    }

    #[inline(always)]
    fn osc_start(&mut self) {
        erase_osc(self.osc_raw.as_mut_slice());
        self.osc_raw.clear();
        self.osc_num_params = 0;
        self.state = State::OscString;
    }

    fn osc_end<P: Perform>(&mut self, performer: &mut P, byte: u8) {
        self.action_osc_put_param();
        if self.ignoring {
            performer.control_cancelled();
        } else {
            self.osc_dispatch(performer, byte);
        }
        erase_osc(self.osc_raw.as_mut_slice());
        self.osc_raw.clear();
        self.osc_num_params = 0;
    }

    /// Reset escape sequence parameters and intermediates.
    #[inline]
    fn reset_params(&mut self) {
        self.intermediate_idx = 0;
        self.ignoring = false;
        self.param = 0;

        self.params.clear();
    }

    /// Separate method for osc_dispatch that borrows self as read-only
    ///
    /// The aliasing is needed here for multiple slices into self.osc_raw
    #[inline]
    fn osc_dispatch<P: Perform>(&self, performer: &mut P, byte: u8) {
        let mut slices: [MaybeUninit<&[u8]>; MAX_OSC_PARAMS] =
            unsafe { MaybeUninit::uninit().assume_init() };

        for (i, slice) in slices.iter_mut().enumerate().take(self.osc_num_params) {
            let indices = self.osc_params[i];
            *slice = MaybeUninit::new(&self.osc_raw[indices.0..indices.1]);
        }

        unsafe {
            let num_params = self.osc_num_params;
            let params = &slices[..num_params] as *const [MaybeUninit<&[u8]>] as *const [&[u8]];
            performer.osc_dispatch(&*params, byte == 0x07);
        }
    }

    /// Advance from ground. An escape that follows another control is the
    /// common case in redraw streams, and stays in the advance loop; text goes
    /// to the out-of-line classifier, so its loop never competes for registers
    /// with the per-byte state machine.
    #[inline(always)]
    fn advance_ground<P: Perform>(&mut self, performer: &mut P, bytes: &[u8]) -> usize {
        if bytes[0] == 0x1B {
            performer.observe_application_bytes(&bytes[..1]);
            return 1 + self.escape_from_ground(performer, &bytes[1..]);
        }
        self.advance_ground_text(performer, bytes)
    }

    /// Classify ground bytes: C0 controls one at a time, and the text between
    /// them observed once and split into printable ASCII runs and decoded
    /// non-ASCII characters.
    #[inline(never)]
    fn advance_ground_text<P: Perform>(&mut self, performer: &mut P, bytes: &[u8]) -> usize {
        let mut i = 0;
        while i < bytes.len() {
            let byte = bytes[i];
            if byte < 0x20 {
                performer.observe_application_bytes(&bytes[i..i + 1]);
                i += 1;
                if byte == 0x1B {
                    return i + self.escape_from_ground(performer, &bytes[i..]);
                }
                performer.execute(byte);
                continue;
            }

            // ASCII text up to a control or the end of the read is the common
            // case: one scan, one observation, one run.
            let run = printable_ascii_len(&bytes[i..]);
            let next = i + run;
            if next == bytes.len() || bytes[next] < 0x20 {
                performer.observe_application_bytes(&bytes[i..next]);
                // SAFETY: Printable ASCII is valid UTF-8.
                performer.print_str(unsafe { str::from_utf8_unchecked(&bytes[i..next]) });
                i = next;
                continue;
            }

            // The text goes on past DEL or an eight-bit byte: observe it up to
            // the next control once, then split it into ASCII runs and decoded
            // characters.
            let end = next + text_len(&bytes[next..]);
            performer.observe_application_bytes(&bytes[i..end]);
            if run != 0 {
                // SAFETY: Printable ASCII is valid UTF-8.
                performer.print_str(unsafe { str::from_utf8_unchecked(&bytes[i..next]) });
            }
            i = next;
            while i < end {
                let run = printable_ascii_len(&bytes[i..end]);
                if run != 0 {
                    // SAFETY: Printable ASCII is valid UTF-8.
                    performer.print_str(unsafe { str::from_utf8_unchecked(&bytes[i..i + run]) });
                    i += run;
                } else {
                    i = self.advance_non_ascii(performer, bytes, i, end);
                }
            }
        }
        i
    }

    /// Decode the DEL and eight-bit characters from `i` up to the next ASCII
    /// byte or `end`, returning where it stopped: `bytes.len()` when an
    /// incomplete character at the end of the read was kept for the next one.
    #[inline]
    fn advance_non_ascii<P: Perform>(
        &mut self,
        performer: &mut P,
        bytes: &[u8],
        mut i: usize,
        end: usize,
    ) -> usize {
        while i < end && bytes[i] >= 0x7F {
            let lead = bytes[i];
            if lead == 0x7F {
                performer.print('\u{7f}');
                i += 1;
                continue;
            }

            let (width, mut codepoint, second_min, second_max) = match lead {
                0xC2..=0xDF => (2, u32::from(lead & 0x1F), 0x80, 0xBF),
                0xE0 => (3, u32::from(lead & 0x0F), 0xA0, 0xBF),
                0xED => (3, u32::from(lead & 0x0F), 0x80, 0x9F),
                0xE1..=0xEF => (3, u32::from(lead & 0x0F), 0x80, 0xBF),
                0xF0 => (4, u32::from(lead & 0x07), 0x90, 0xBF),
                0xF4 => (4, u32::from(lead & 0x07), 0x80, 0x8F),
                0xF1..=0xF3 => (4, u32::from(lead & 0x07), 0x80, 0xBF),
                _ => {
                    if lead <= 0x9F {
                        performer.execute(lead);
                    } else {
                        performer.print('\u{fffd}');
                    }
                    i += 1;
                    continue;
                },
            };

            let mut len = 1;
            while len < width && i + len < end {
                let byte = bytes[i + len];
                let valid = if len == 1 {
                    (second_min..=second_max).contains(&byte)
                } else {
                    (0x80..=0xBF).contains(&byte)
                };
                if !valid {
                    break;
                }
                codepoint = (codepoint << 6) | u32::from(byte & 0x3F);
                len += 1;
            }

            if len == width {
                if lead == 0xC2 && bytes[i + 1] <= 0x9F {
                    performer.execute(bytes[i + 1]);
                } else {
                    // SAFETY: The lead and continuation ranges exclude overlong
                    // encodings, surrogates and values beyond U+10FFFF.
                    performer.print(unsafe { char::from_u32_unchecked(codepoint) });
                }
            } else if i + len == bytes.len() {
                self.partial_utf8[..len].copy_from_slice(&bytes[i..]);
                self.partial_utf8_len = len;
                return bytes.len();
            } else {
                // Exactly Utf8Error::error_len(): leave the first bad byte for
                // the next iteration (or the ground loop at an ASCII boundary).
                performer.print('\u{fffd}');
            }
            i += len;
        }
        i
    }

    /// ESC found in ground text. Controls whose introducer follows in the same
    /// slice are parsed out of line instead of one byte per loop turn.
    #[inline(always)]
    fn escape_from_ground<P: Perform>(&mut self, performer: &mut P, rest: &[u8]) -> usize {
        // Perform's termination guarantee lets these paths continue through
        // internal actions and return to the outer check after dispatch.
        self.start_escape(performer);
        match rest.first() {
            Some(b'[') => self.advance_csi(performer, rest),
            Some(b']') => self.advance_osc(performer, rest),
            Some(b'P') => self.advance_dcs(performer, rest),
            _ => 0,
        }
    }

    #[inline(never)]
    fn advance_osc<P: Perform>(&mut self, performer: &mut P, bytes: &[u8]) -> usize {
        // ']' in Escape: share advance_esc's 0x5D arm.
        self.osc_start();
        performer.observe_application_bytes(&bytes[..1]);
        1 + self.advance_osc_string(performer, &bytes[1..])
    }

    #[inline(never)]
    fn advance_osc_string<P: Perform>(&mut self, performer: &mut P, bytes: &[u8]) -> usize {
        let mut i = 0;
        loop {
            let run = osc_payload_len(&bytes[i..]);
            if run != 0 {
                performer.observe_application_bytes(&bytes[i..i + run]);
                self.action_osc_put_slice(&bytes[i..i + run]);
                i += run;
            }
            if i == bytes.len() {
                return i;
            }
            let byte = bytes[i];
            performer.observe_application_bytes(core::slice::from_ref(&byte));
            i += 1;
            self.advance_osc_string_byte(performer, byte);
            match self.state {
                State::OscString => continue,
                // Let the byte handler distinguish ST from cancellation now
                // when this read also contains the byte after ESC.
                State::OscEscape if i < bytes.len() => {
                    let byte = bytes[i];
                    performer.observe_application_bytes(core::slice::from_ref(&byte));
                    self.advance_osc_escape(performer, byte);
                    return i + 1;
                },
                _ => return i,
            }
        }
    }

    #[inline(never)]
    fn advance_dcs<P: Perform>(&mut self, performer: &mut P, bytes: &[u8]) -> usize {
        // 'P' in Escape: start_escape already reset the parameters.
        self.state = State::DcsEntry;
        let mut i = 1;
        let mut observed = 0;
        while i < bytes.len() {
            let byte = bytes[i];
            if self.state == State::DcsPassthrough {
                let run = bytes[i..]
                    .iter()
                    .position(|&b| !matches!(b, 0x00..=0x17 | 0x19 | 0x1C..=0x7E))
                    .unwrap_or(bytes.len() - i);
                if run != 0 {
                    performer.observe_application_bytes(&bytes[observed..i + run]);
                    for &byte in &bytes[i..i + run] {
                        performer.put(byte);
                    }
                    i += run;
                    observed = i;
                }
                if i == bytes.len() {
                    break;
                }
                match bytes[i] {
                    0x7F => i += 1,
                    0x1B => {
                        i += 1;
                        performer.observe_application_bytes(&bytes[observed..i]);
                        self.advance_dcs_passthrough(performer, 0x1B);
                        // Termination is honoured after `unhook`, as the byte machine does.
                        if i < bytes.len() && !performer.terminated() {
                            let byte = bytes[i];
                            performer.observe_application_bytes(core::slice::from_ref(&byte));
                            self.advance_esc(performer, byte);
                            i += 1;
                        }
                        return i;
                    },
                    _ => break, // CAN, SUB and 8-bit bytes stay with the byte machine.
                }
                continue;
            }

            match byte {
                // Entry, Param and Intermediate explicitly ignore these C0s
                // and DEL; DcsIgnore's anywhere handler also ignores them.
                0x00..=0x17 | 0x19 | 0x1C..=0x1F | 0x7F => i += 1,
                0x20..=0x3F => {
                    i += 1;
                    match self.state {
                        State::DcsEntry => self.advance_dcs_entry(performer, byte),
                        State::DcsParam => self.advance_dcs_param(performer, byte),
                        State::DcsIntermediate => self.advance_dcs_intermediate(performer, byte),
                        _ => (), // DcsIgnore ignores 0x20..=0x3F.
                    }
                },
                0x40..=0x7E => {
                    i += 1;
                    if self.state != State::DcsIgnore {
                        performer.observe_application_bytes(&bytes[observed..i]);
                        observed = i;
                        self.action_hook(performer, byte);
                    }
                },
                _ => break, // Header CAN, SUB, ESC and 8-bit bytes use anywhere.
            }
        }
        if observed != i {
            performer.observe_application_bytes(&bytes[observed..i]);
        }
        i
    }

    #[inline(never)]
    fn advance_csi<P: Perform>(&mut self, performer: &mut P, bytes: &[u8]) -> usize {
        // '[' in Escape: advance_esc's 0x5B arm. start_escape already reset the params.
        self.state = State::CsiEntry;
        let mut i = 1;
        while i < bytes.len() {
            let byte = bytes[i];
            // C0 controls execute; DEL and 8-bit bytes are ignored or cancel.
            // Leave these rare bytes to the per-byte state machine.
            if !(0x20..=0x7E).contains(&byte) {
                break;
            }
            if byte >= 0x40 {
                i += 1;
                performer.observe_application_bytes(&bytes[..i]);
                if self.state == State::CsiIgnore {
                    self.state = State::Ground;
                } else {
                    self.action_csi_dispatch(performer, byte);
                }
                return i;
            }

            if byte.is_ascii_digit() && matches!(self.state, State::CsiEntry | State::CsiParam) {
                self.state = State::CsiParam;
                // Digits never extend params, so is_full is invariant within a
                // run. Preserve action_paramnext's ignoring and u16 saturation.
                if self.params.is_full() {
                    self.ignoring = true;
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                } else {
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        self.param =
                            self.param.saturating_mul(10).saturating_add((bytes[i] - b'0') as u16);
                        i += 1;
                    }
                }
                continue;
            }

            i += 1;
            // For 0x20..=0x3F these handlers only update parser fields: collect,
            // param, subparam and state changes never call Perform. Observation
            // can therefore stay batched until dispatch or this slice ends.
            match self.state {
                State::CsiEntry => self.advance_csi_entry(performer, byte),
                State::CsiParam => self.advance_csi_param(performer, byte),
                State::CsiIntermediate => self.advance_csi_intermediate(performer, byte),
                _ => (), // CsiIgnore ignores 0x20..=0x3F.
            }
        }
        performer.observe_application_bytes(&bytes[..i]);
        i
    }

    /// Advance the parser while processing a partial utf8 codepoint.
    #[inline]
    fn advance_partial_utf8<P: Perform>(&mut self, performer: &mut P, bytes: &[u8]) -> usize {
        // Try to copy up to 3 more characters, to ensure the codepoint is complete.
        let old_bytes = self.partial_utf8_len;
        let to_copy = bytes.len().min(self.partial_utf8.len() - old_bytes);
        self.partial_utf8[old_bytes..old_bytes + to_copy].copy_from_slice(&bytes[..to_copy]);
        self.partial_utf8_len += to_copy;

        // Parse the unicode character.
        match str::from_utf8(&self.partial_utf8[..self.partial_utf8_len]) {
            // If the entire buffer is valid, use the first character and continue parsing.
            Ok(parsed) => {
                let c = unsafe { parsed.chars().next().unwrap_unchecked() };
                performer.observe_application_bytes(&bytes[..c.len_utf8() - old_bytes]);
                Self::dispatch_completed_char(performer, c);

                self.partial_utf8_len = 0;
                c.len_utf8() - old_bytes
            },
            Err(err) => {
                let valid_bytes = err.valid_up_to();
                // If we have any valid bytes, that means we partially copied another
                // utf8 character into `partial_utf8`. Only the first character is
                // consumed here; whatever follows it is parsed again from `bytes`.
                if valid_bytes > 0 {
                    let c = unsafe {
                        let parsed = str::from_utf8_unchecked(&self.partial_utf8[..valid_bytes]);
                        parsed.chars().next().unwrap_unchecked()
                    };

                    let consumed = c.len_utf8() - old_bytes;
                    performer.observe_application_bytes(&bytes[..consumed]);
                    Self::dispatch_completed_char(performer, c);

                    self.partial_utf8_len = 0;
                    return consumed;
                }

                match err.error_len() {
                    // If the partial character was also invalid, emit the replacement
                    // character.
                    Some(invalid_len) => {
                        performer.observe_application_bytes(&bytes[..invalid_len - old_bytes]);
                        performer.print('�');

                        self.partial_utf8_len = 0;
                        invalid_len - old_bytes
                    },
                    // If the character still isn't complete, wait for more data.
                    None => {
                        performer.observe_application_bytes(&bytes[..to_copy]);
                        to_copy
                    },
                }
            },
        }
    }

    /// A character completed across `advance` calls means what it would have
    /// meant in one call: a C1 control (`U+0080..=U+009F`) is executed, as
    /// in [`Self::advance_non_ascii`], and anything else is printed.
    #[inline]
    fn dispatch_completed_char<P: Perform>(performer: &mut P, c: char) {
        if ('\u{80}'..='\u{9f}').contains(&c) {
            performer.execute(c as u8);
        } else {
            performer.print(c);
        }
    }
}

impl<const OSC_RAW_BUF_SIZE: usize> Drop for Parser<OSC_RAW_BUF_SIZE> {
    fn drop(&mut self) {
        // An incomplete OSC 52 can still own clipboard text at parser retirement.
        erase_osc(self.osc_raw.as_mut_slice());
    }
}

#[derive(PartialEq, Eq, Debug, Default, Copy, Clone)]
enum State {
    CsiEntry,
    CsiIgnore,
    CsiIntermediate,
    CsiParam,
    DcsEntry,
    DcsIgnore,
    DcsIntermediate,
    DcsParam,
    DcsPassthrough,
    Escape,
    EscapeIntermediate,
    OscString,
    OscEscape,
    SosPmString,
    ApcString,
    ApcEscape,
    #[default]
    Ground,
}

/// Performs actions requested by the Parser
///
/// Actions in this case mean, for example, handling a CSI escape sequence
/// describing cursor movement, or simply printing characters to the screen.
///
/// The methods on this type correspond to actions described in
/// <http://vt100.net/emu/dec_ansi_parser>. I've done my best to describe them in
/// a useful way in my own words for completeness, but the site should be
/// referenced if something isn't clear. If the site disappears at some point in
/// the future, consider checking archive.org.
pub trait Perform {
    /// Observe exactly the bytes entering terminal semantics, before their
    /// corresponding action. Ground text is observed in slices up to the next
    /// C0 control (C1 controls and malformed UTF-8 inside it included), C0
    /// controls and ESC one byte at a time, and control sequences parsed from
    /// a slice as one slice before their dispatch. This is below synchronized
    /// buffering.
    #[inline]
    fn observe_application_bytes(&mut self, _bytes: &[u8]) {}

    /// Begins a fresh ESC sequence, including a completed OSC terminator.
    fn control_started(&mut self) {}

    /// An incomplete control was abandoned, rather than normally dispatched.
    fn control_cancelled(&mut self) {}

    /// Begin a seven-bit APC (`ESC _`). Unknown application commands must be
    /// ignored by the receiver, independently of any preceding command.
    fn apc_start(&mut self) {}

    /// Borrow a nonempty slice of APC contents, excluding the introducer and
    /// terminator. Slice boundaries have no semantic meaning. C0/C1 bytes other
    /// than CAN, SUB, and ESC are opaque data for the receiver to validate.
    fn apc_put(&mut self, _bytes: &[u8]) {}

    /// Finish an APC. `complete` is true only for a complete `ESC \\` terminator;
    /// CAN, SUB, or an unrelated escape cancel the command. This callback is
    /// delivered exactly once per start, unless input ends inside the command.
    fn apc_end(&mut self, _complete: bool) {}

    /// Draw a character to the screen and update states.
    fn print(&mut self, _c: char) {}

    /// Draw a non-empty run of printable ASCII (`0x20..=0x7E`).
    ///
    /// DEL and every non-ASCII printable character arrive through [`Perform::print`].
    /// The default forwards to `print` per character; override it when writing
    /// a run in one pass is cheaper than writing each character separately.
    #[inline]
    fn print_str(&mut self, s: &str) {
        for c in s.chars() {
            self.print(c);
        }
    }

    /// Execute a C0 or C1 control function.
    fn execute(&mut self, _byte: u8) {}

    /// Invoked when a final character arrives in first part of device control
    /// string.
    ///
    /// The control function should be determined from the private marker, final
    /// character, and execute with a parameter list. A handler should be
    /// selected for remaining characters in the string; the handler
    /// function should subsequently be called by `put` for every character in
    /// the control string.
    ///
    /// The `ignore` flag indicates that more than two intermediates arrived and
    /// subsequent characters were ignored.
    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {}

    /// Pass bytes as part of a device control string to the handle chosen in
    /// `hook`. C0 controls will also be passed to the handler.
    fn put(&mut self, _byte: u8) {}

    /// Called when a device control string is terminated.
    ///
    /// The previously selected handler should be notified that the DCS has
    /// terminated.
    fn unhook(&mut self) {}

    /// Dispatch an operating system command.
    fn osc_dispatch(&mut self, _params: &[&[u8]], _bell_terminated: bool) {}

    /// A final character has arrived for a CSI sequence
    ///
    /// The `ignore` flag indicates that either more than two intermediates
    /// arrived or the number of parameters exceeded the maximum supported
    /// length, and subsequent characters were ignored.
    fn csi_dispatch(
        &mut self,
        _params: &Params,
        _intermediates: &[u8],
        _ignore: bool,
        _action: char,
    ) {
    }

    /// The final character of an escape sequence has arrived.
    ///
    /// The `ignore` flag indicates that more than two intermediates arrived and
    /// subsequent characters were ignored.
    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {}

    /// Whether the parser should terminate prematurely.
    ///
    /// This can be used in conjunction with
    /// [`Parser::advance_until_terminated`] to terminate the parser after
    /// receiving certain escape sequences like synchronized updates.
    ///
    /// Termination is honoured after dispatches (`csi_dispatch`, `esc_dispatch`,
    /// `osc_dispatch`, `unhook` and `apc_end`). Implementations must not start
    /// terminating from `print`, `print_str`, `execute`, `put`, `hook`, `apc_put`,
    /// `control_started`, `control_cancelled` or `observe_application_bytes`.
    /// Ground text and control payloads can therefore be processed in runs.
    /// This check must be cheap; no expensive computation should take place here.
    #[inline(always)]
    fn terminated(&self) -> bool {
        false
    }
}

#[cfg(all(test, not(feature = "std")))]
#[macro_use]
extern crate std;

#[cfg(test)]
mod tests {
    use std::borrow::ToOwned;
    use std::string::String;
    use std::vec::Vec;

    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    enum Event {
        Text(String),
        Execute(u8, usize),
        Csi(Vec<Vec<u16>>, Vec<u8>, bool, char, usize),
        Esc(Vec<u8>, bool, u8, usize),
        Osc(Vec<Vec<u8>>, bool, usize),
        Hook(Vec<Vec<u16>>, Vec<u8>, bool, char, usize),
        Put(u8),
        Unhook(usize),
        ApcStart(usize),
        ApcPut(Vec<u8>),
        ApcEnd(bool, usize),
        ControlStarted(usize),
        ControlCancelled(usize),
    }

    #[derive(Default)]
    struct Recorder {
        events: Vec<Event>,
        observed: Vec<u8>,
        stop_on_csi: Option<char>,
        stop_on_unhook: bool,
        stopped: bool,
    }

    impl Perform for Recorder {
        fn observe_application_bytes(&mut self, bytes: &[u8]) {
            self.observed.extend_from_slice(bytes);
        }

        fn print(&mut self, c: char) {
            match self.events.last_mut() {
                Some(Event::Text(previous)) => previous.push(c),
                _ => self.events.push(Event::Text(c.to_string())),
            }
        }

        fn print_str(&mut self, text: &str) {
            assert!(!text.is_empty());
            assert!(text.bytes().all(|byte| matches!(byte, 0x20..=0x7E)));
            match self.events.last_mut() {
                Some(Event::Text(previous)) => previous.push_str(text),
                _ => self.events.push(Event::Text(text.to_owned())),
            }
        }

        fn execute(&mut self, byte: u8) {
            self.events.push(Event::Execute(byte, self.observed.len()));
        }

        fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, c: char) {
            self.events.push(Event::Csi(
                params.iter().map(|p| p.to_vec()).collect(),
                intermediates.to_vec(),
                ignore,
                c,
                self.observed.len(),
            ));
            if self.stop_on_csi == Some(c) {
                self.stopped = true;
            }
        }

        fn esc_dispatch(&mut self, intermediates: &[u8], ignore: bool, byte: u8) {
            self.events.push(Event::Esc(intermediates.to_vec(), ignore, byte, self.observed.len()));
        }

        fn osc_dispatch(&mut self, params: &[&[u8]], bell_terminated: bool) {
            self.events.push(Event::Osc(
                params.iter().map(|p| p.to_vec()).collect(),
                bell_terminated,
                self.observed.len(),
            ));
        }

        fn hook(&mut self, params: &Params, intermediates: &[u8], ignore: bool, c: char) {
            self.events.push(Event::Hook(
                params.iter().map(|p| p.to_vec()).collect(),
                intermediates.to_vec(),
                ignore,
                c,
                self.observed.len(),
            ));
        }

        fn put(&mut self, byte: u8) {
            self.events.push(Event::Put(byte));
        }

        fn unhook(&mut self) {
            self.events.push(Event::Unhook(self.observed.len()));
            self.stopped |= self.stop_on_unhook;
        }

        fn apc_start(&mut self) {
            self.events.push(Event::ApcStart(self.observed.len()));
        }

        fn apc_put(&mut self, bytes: &[u8]) {
            match self.events.last_mut() {
                Some(Event::ApcPut(previous)) => previous.extend_from_slice(bytes),
                _ => self.events.push(Event::ApcPut(bytes.to_vec())),
            }
        }

        fn apc_end(&mut self, complete: bool) {
            self.events.push(Event::ApcEnd(complete, self.observed.len()));
        }

        fn control_started(&mut self) {
            self.events.push(Event::ControlStarted(self.observed.len()));
        }

        fn control_cancelled(&mut self) {
            self.events.push(Event::ControlCancelled(self.observed.len()));
        }

        fn terminated(&self) -> bool {
            self.stopped
        }
    }

    // A C1 execution may observe its entire non-ASCII stretch up front. Keep
    // all C0 and control-dispatch offsets, but compare C1 actions independently
    // of observation slice boundaries; observed bytes are checked separately.
    fn normalize_ground_observation(events: &mut [Event]) {
        for event in events {
            if let Event::Execute(0x80..=0x9F, observed) = event {
                *observed = 0;
            }
        }
    }

    /// Shared differential corpus for parser slice paths. Fragments deliberately
    /// mix valid commands, ignored states, cancellations and malformed UTF-8.
    fn parser_corpus(state: &mut u32) -> Vec<u8> {
        let mut out = b"\x1b[?2026h".to_vec();
        for _ in 0..40 + lcg(state) % 40 {
            match lcg(state) % 30 {
                0..=2 => out.extend_from_slice(b"word prompt /tmp/file 0123456789"),
                3 => out.extend_from_slice("é終🌍e\u{301}".as_bytes()),
                4 => out.push((lcg(state) % 32) as u8),
                5 => out.extend_from_slice(&[0xC2, 0x80 + (lcg(state) % 32) as u8]),
                6 => out.push(0x80 + (lcg(state) % 32) as u8),
                7 => out.push(0x7F),
                8 => {
                    let invalid: &[&[u8]] = &[b"\xff", b"\xe2\x82", b"\xc0\x80", b"\xed\xa0\x80"];
                    out.extend_from_slice(invalid[lcg(state) % invalid.len()]);
                },
                9 => {
                    out.push(0x1B);
                    for _ in 0..lcg(state) % 5 {
                        out.push(b' ' + (lcg(state) % 16) as u8);
                    }
                    out.extend_from_slice(b"\x00\x7fB");
                },
                10..=13 => {
                    out.extend_from_slice(b"\x1b[");
                    if lcg(state) % 2 == 0 {
                        out.push(b"?<=>"[lcg(state) % 4]);
                    }
                    let count = lcg(state) % 41;
                    for param in 0..count {
                        if param != 0 {
                            out.push(if lcg(state) % 3 == 0 { b':' } else { b';' });
                        }
                        let digits = if lcg(state) % 8 == 0 { 40 } else { lcg(state) % 6 };
                        for _ in 0..digits {
                            out.push(b'0' + (lcg(state) % 10) as u8);
                        }
                        if lcg(state) % 4 == 0 {
                            out.extend_from_slice(b"\x00\x0d\x7f");
                        }
                    }
                    match lcg(state) % 5 {
                        0 => out.extend_from_slice(b" !\""), // Too many intermediates.
                        1 => out.extend_from_slice(b" 0"),   // CSI ignore.
                        2 => out.extend_from_slice(b"?"),    // Private marker after params.
                        3 => out.extend_from_slice(b" $"),
                        _ => (),
                    }
                    out.push(b"hmHJ"[lcg(state) % 4]);
                },
                14..=18 => {
                    out.extend_from_slice(b"\x1b]");
                    let separators = lcg(state) % 21;
                    let leading = lcg(state) % (separators + 1);
                    out.extend(core::iter::repeat(b';').take(leading));
                    let len = if lcg(state) % 64 == 0 {
                        2 * 1024 + (lcg(state) * 2 + lcg(state) % 2) % (68 * 1024 + 1)
                    } else {
                        lcg(state) % 301
                    };
                    // Include the SIMD stop boundaries, raw ST, UTF-8 and DEL.
                    let payload = b"abc:XYZ\x7f\x9c\xc3\xa9\xe7\xb5\x82\xf0\x9f\x8c\x8d";
                    let middle = len / 2;
                    out.extend(payload.iter().copied().cycle().take(middle));
                    out.extend_from_slice(b"\x00\x01\x06\x08\x17\x19\x1c\x1f");
                    out.extend(payload.iter().copied().cycle().skip(middle).take(len - middle));
                    out.extend(core::iter::repeat(b';').take(separators - leading));
                    out.extend_from_slice(b"\x00\x01\x06\x08\x17\x19\x1c\x1f");
                    let endings: &[&[u8]] =
                        &[b"\x07", b"\x1b\\", b"\x1b[31m", b"\x18", b"\x1a", b"\x1b!p"];
                    out.extend_from_slice(endings[lcg(state) % endings.len()]);
                },
                19 => {
                    out.extend_from_slice(b"\x1bP");
                    let headers: &[&[u8]] = &[
                        b"",
                        b"1;2:3$",
                        b"?<1", // Private marker after params enters DcsIgnore.
                        b"1 0", // Parameter after intermediate enters DcsIgnore.
                        b"!",
                        b"1:2;99999999999999999999",
                        b" !\"", // Intermediate overflow sets ignoring on hook.
                        b"\x00\x17\x19\x1c\x1f\x7f1\x00;2\x7f$\x01",
                    ];
                    out.extend_from_slice(headers[lcg(state) % headers.len()]);
                    if lcg(state) % 4 == 0 {
                        // Stop before rare bytes while still in the header.
                        let stops: &[&[u8]] = &[b"\x18", b"\x1a", b"\x1b[H", b"\xff\x9c"];
                        out.extend_from_slice(stops[lcg(state) % stops.len()]);
                    } else {
                        out.push(b"q|p"[lcg(state) % 3]);
                        let body = b"tmux;data\x00\x07\x17\x19\x1c\x1f\x7f~";
                        out.extend(body.iter().copied().cycle().take(lcg(state) % 301));
                        let endings: &[&[u8]] = &[
                            b"\x1b\\",
                            b"\x18",
                            b"\x1a",
                            b"\x1b[31m",
                            b"\xff\x80\x9c",
                            b"\xc3\xa9\x1b!p",
                        ];
                        out.extend_from_slice(endings[lcg(state) % endings.len()]);
                    }
                },
                20..=21 => {
                    out.extend_from_slice(b"\x1b_Gdata;\x00\x07\x9c\xc2\x9c\xff");
                    let endings: &[&[u8]] = &[b"\x1b\\", b"\x18", b"\x1a", b"\x1b[H"];
                    out.extend_from_slice(endings[lcg(state) % endings.len()]);
                },
                22 => out.extend_from_slice(b"\x1bXsos\x07\x18\x1b^pm\x9c\x1b\\"),
                23 => out.extend_from_slice(b"\x1b[?2026h"),
                24 => out.extend_from_slice(b"\x1b[H\x1b[0m\x1b[?1049h\x1b[>4;2m"),
                25 => {
                    out.extend_from_slice(b"\x1b[");
                    for param in 0..1 + lcg(state) % 16 {
                        if param != 0 {
                            out.push(if lcg(state) % 4 == 0 { b':' } else { b';' });
                        }
                        for _ in 0..lcg(state) % 6 {
                            out.push(b'0' + (lcg(state) % 10) as u8);
                        }
                    }
                    out.push(b'm');
                },
                26 => {
                    out.extend_from_slice(b"\x1b[");
                    for _ in 0..params::MAX_PARAMS + 1 + lcg(state) % 16 {
                        out.extend_from_slice(b"12345;");
                    }
                    out.extend_from_slice(b"99999999999999m");
                },
                27 => {
                    out.extend_from_slice(b"\x1b[");
                    out.push(b"?<=>"[lcg(state) % 4]);
                    out.extend_from_slice(b"1;2");
                    for _ in 0..1 + lcg(state) % 3 {
                        out.push(b' ' + (lcg(state) % 16) as u8);
                    }
                    out.push(b'p');
                },
                28 => {
                    out.extend_from_slice(b"\x1b[1");
                    if lcg(state) % 2 == 0 {
                        out.push(b'<' + (lcg(state) % 4) as u8);
                    } else {
                        out.push(b' ' + (lcg(state) % 16) as u8);
                        out.push(b'0' + (lcg(state) % 16) as u8);
                    }
                    out.extend_from_slice(b"2m");
                },
                _ => {
                    let mut csi = b"\x1b[38;2;12;34;56m".to_vec();
                    let rare = match lcg(state) % 6 {
                        0 => (lcg(state) % 32) as u8,
                        1 => 0x7F,
                        2 => 0x80 + (lcg(state) % 128) as u8,
                        3 => 0x1B,
                        4 => 0x18,
                        _ => 0x1A,
                    };
                    let position = 2 + lcg(state) % (csi.len() - 2);
                    csi.insert(position, rare);
                    out.extend_from_slice(&csi);
                },
            }
        }
        // Force a real stop after the random fragments, then leave each state
        // and partial UTF-8 pending frequently at the end of a corpus.
        out.extend_from_slice(b"\x18\x1b[?2026h");
        let tails: &[&[u8]] = &[
            b"",
            b"\xe2\x82",
            b"\xf0\x9f\x8c",
            b"\x1b",
            b"\x1b!",
            b"\x1b[",
            b"\x1b[1:2;",
            b"\x1b[!",
            b"\x1b[ 0",
            b"\x1b]52;c;unfinished",
            b"\x1b]0;end\x1b",
            b"\x1bP",
            b"\x1bP1;",
            b"\x1bP!",
            b"\x1bP 0",
            b"\x1bPqbody",
            b"\x1b_Gdata",
            b"\x1b_Gdata\x1b",
            b"\x1b^pending",
        ];
        out.extend_from_slice(tails[lcg(state) % tails.len()]);
        out
    }

    fn parser_chunk_len(state: &mut u32) -> usize {
        let limit = [8, 64, 4096][lcg(state) % 3];
        1 + lcg(state) % limit
    }

    fn drive_until_terminated(
        input: &[u8],
        mut chunk_len: impl FnMut() -> usize,
    ) -> (Recorder, Vec<usize>, bool) {
        let mut parser = Parser::new();
        let mut recorder = Recorder { stop_on_csi: Some('h'), ..Default::default() };
        let mut stops = Vec::new();
        let mut offset = 0;
        while offset < input.len() {
            let end = (offset + chunk_len()).min(input.len());
            while offset < end {
                let consumed = parser.advance_until_terminated(&mut recorder, &input[offset..end]);
                assert!(consumed > 0);
                offset += consumed;
                assert_eq!(recorder.observed, input[..offset]);
                if recorder.stopped {
                    stops.push(offset);
                    // A stopped driver must consume nothing until cleared.
                    assert_eq!(
                        parser.advance_until_terminated(&mut recorder, &input[offset..end]),
                        0
                    );
                    recorder.stopped = false;
                }
            }
        }
        (recorder, stops, parser.control_pending())
    }

    #[test]
    fn termination_after_unhook_leaves_the_next_byte_unread() {
        let input = b"\x1bPq\x1bc";
        let mut parser = Parser::new();
        let mut recorder = Recorder { stop_on_unhook: true, ..Default::default() };
        assert_eq!(parser.advance_until_terminated(&mut recorder, input), 4);
        assert_eq!(recorder.observed, input[..4]);
        assert!(!recorder.events.iter().any(|event| matches!(event, Event::Esc(..))));
        recorder.stopped = false;
        assert_eq!(parser.advance_until_terminated(&mut recorder, &input[4..]), 1);
        assert!(matches!(recorder.events.last(), Some(Event::Esc(_, false, b'c', 5))));
    }

    #[test]
    fn controls_from_ground_match_byte_at_a_time_under_random_chunking() {
        let mut state = 0xC391_A52D;
        for corpus in 0..2_000 {
            let input = parser_corpus(&mut state);
            let mut reference = Parser::new();
            let mut expected = Recorder::default();
            // ESC is last in every read. OSC continuations feed exactly one
            // byte to the slice path, which delegates to the byte table.
            for byte in input.chunks(1) {
                reference.advance(&mut expected, byte);
            }
            assert_eq!(expected.observed, input, "reference observation, corpus {corpus}");
            normalize_ground_observation(&mut expected.events);

            let mut chunk_state = state;
            for whole in [true, false] {
                let mut parser = Parser::new();
                let mut recorder = Recorder::default();
                let mut offset = 0;
                while offset < input.len() {
                    let len = if whole { input.len() } else { parser_chunk_len(&mut chunk_state) };
                    let end = (offset + len).min(input.len());
                    parser.advance(&mut recorder, &input[offset..end]);
                    offset = end;
                }
                assert_eq!(recorder.observed, input, "observation, corpus {corpus}, whole {whole}");
                normalize_ground_observation(&mut recorder.events);
                assert_eq!(
                    recorder.events, expected.events,
                    "events, corpus {corpus}, whole {whole}"
                );
                assert_eq!(parser.control_pending(), reference.control_pending(), "{corpus}");
            }
        }
    }

    #[test]
    fn controls_from_ground_until_terminated_match_byte_at_a_time() {
        let mut state = 0xC391_A52D;
        for corpus in 0..2_000 {
            let input = parser_corpus(&mut state);
            let (mut expected, expected_stops, expected_pending) =
                drive_until_terminated(&input, || 1);
            let mut chunk_state = state;
            let (mut actual, stops, pending) =
                drive_until_terminated(&input, || parser_chunk_len(&mut chunk_state));
            normalize_ground_observation(&mut expected.events);
            normalize_ground_observation(&mut actual.events);
            assert_eq!(stops, expected_stops, "stop offsets, corpus {corpus}");
            assert!(!stops.is_empty());
            assert_eq!(actual.events, expected.events, "events, corpus {corpus}");
            assert_eq!(expected.observed, input, "reference observation, corpus {corpus}");
            assert_eq!(actual.observed, input, "observation, corpus {corpus}");
            assert_eq!(pending, expected_pending, "pending, corpus {corpus}");
        }
    }

    #[cfg(feature = "std")]
    #[test]
    fn osc_bulk_capacity_matches_per_byte_growth() {
        for len in [0, 1, 63, 64, 65, 127, 128, 129, 1000, 65536, 70000, MAX_OSC_STRING_BYTES + 10]
        {
            let mut input = b"\x1b]".to_vec();
            input.extend(core::iter::repeat(b'a').take(len));
            let mut reference = Parser::new();
            for byte in input.chunks(1) {
                reference.advance(&mut Dispatcher::default(), byte);
            }
            for chunk_len in [input.len(), 7] {
                let mut parser = Parser::new();
                for chunk in input.chunks(chunk_len) {
                    parser.advance(&mut Dispatcher::default(), chunk);
                }
                assert_eq!(parser.state, State::OscString);
                assert_eq!(parser.osc_raw.capacity(), reference.osc_raw.capacity(), "len {len}");
                assert_eq!(parser.osc_raw, reference.osc_raw, "len {len}, chunks {chunk_len}");
                assert_eq!(parser.ignoring, reference.ignoring, "len {len}, chunks {chunk_len}");
            }
        }
    }

    #[test]
    fn osc_payload_scan_matches_the_byte_table_at_every_block_offset() {
        let mut payload = [false; 256];
        for (byte, ordinary) in payload.iter_mut().enumerate() {
            let mut parser = Parser::new();
            parser.state = State::OscString;
            parser.advance_osc_string_byte(&mut Dispatcher::default(), byte as u8);
            *ordinary = parser.osc_raw.as_slice() == [byte as u8];
        }
        let expected =
            |bytes: &[u8]| bytes.iter().position(|&b| !payload[b as usize]).unwrap_or(bytes.len());
        for byte in 0..=255 {
            for offset in 0..=48 {
                let mut bytes = [b'x'; 64];
                bytes[offset] = byte;
                assert_eq!(osc_payload_len(&bytes), expected(&bytes), "byte {byte}, at {offset}");
            }
            for len in 0..16 {
                let bytes = [byte; 16];
                assert_eq!(osc_payload_len(&bytes[..len]), expected(&bytes[..len]));
            }
        }
    }

    #[test]
    fn csi_fast_path_digit_run_saturates_and_limits_like_the_byte_machine() {
        let mut fixtures: Vec<Vec<u8>> = [
            b"\x1b[99999999999999m".as_slice(),
            b"\x1b[1;2;3:4:5;6m",
            b"\x1b[?1049h",
            b"\x1b[>4;2m",
            b"\x1b[ q",
            b"\x1b[1 $p",
            b"\x1b[1?2m",
            b"\x1b[1 2m",
            b"\x1b[1\r2m",
            b"\x1b[1\x7f2m",
            b"\x1b[1\x1b[2m",
            b"\x1b[1\x18",
            b"ab\x1b[38;2;1;2;3mcd\x1b[Hx",
        ]
        .iter()
        .map(|input| input.to_vec())
        .collect();
        for count in [31, 32, 33, 40] {
            let mut input = b"\x1b[".to_vec();
            for param in 0..count {
                if param != 0 {
                    input.push(b';');
                }
                input.extend_from_slice(b"12345");
            }
            input.push(b'm');
            fixtures.push(input);
        }
        let mut input = b"\x1b[".to_vec();
        for _ in 0..31 {
            input.extend_from_slice(b"1;");
        }
        input.extend_from_slice(b"2:3:99999999999999:m");
        fixtures.push(input);

        for input in fixtures {
            let mut reference = Parser::new();
            let mut expected = Recorder::default();
            for byte in input.chunks(1) {
                reference.advance(&mut expected, byte);
            }
            assert_eq!(expected.observed, input);
            // Includes the whole slice and every split across two calls.
            for split in 0..=input.len() {
                let mut parser = Parser::new();
                let mut recorder = Recorder::default();
                parser.advance(&mut recorder, &input[..split]);
                parser.advance(&mut recorder, &input[split..]);
                assert_eq!(recorder.events, expected.events, "input {input:?}, split {split}");
                assert_eq!(recorder.observed, input, "split {split}");
                assert_eq!(parser.control_pending(), reference.control_pending(), "split {split}");
            }
        }
    }

    #[derive(Default)]
    struct ApcObserver {
        observed: Vec<u8>,
        commands: Vec<(Vec<u8>, Option<bool>)>,
        printed: Vec<char>,
        executed: Vec<u8>,
        payload_calls: usize,
        stop_at_end: bool,
        stopped: bool,
    }

    impl Perform for ApcObserver {
        fn observe_application_bytes(&mut self, bytes: &[u8]) {
            self.observed.extend_from_slice(bytes);
        }

        fn apc_start(&mut self) {
            self.commands.push((Vec::new(), None));
        }

        fn apc_put(&mut self, bytes: &[u8]) {
            assert!(!bytes.is_empty());
            let current = self.commands.last_mut().unwrap();
            assert_eq!(current.1, None);
            current.0.extend_from_slice(bytes);
            self.payload_calls += 1;
        }

        fn apc_end(&mut self, complete: bool) {
            let current = self.commands.last_mut().unwrap();
            assert_eq!(current.1.replace(complete), None);
            self.stopped = self.stop_at_end;
        }

        fn print(&mut self, c: char) {
            self.printed.push(c);
        }

        fn execute(&mut self, byte: u8) {
            self.executed.push(byte);
        }

        fn terminated(&self) -> bool {
            self.stopped
        }
    }

    #[test]
    fn apc_framing_is_independent_of_every_pair_of_byte_boundaries() {
        let input = b"a\x1b_Ga=T,f=32;AAAA\x1b\\b\x1b_unknown\x1b\\c";
        for first in 0..=input.len() {
            for second in first..=input.len() {
                let mut parser = Parser::new();
                let mut observer = ApcObserver::default();
                for part in [&input[..first], &input[first..second], &input[second..]] {
                    parser.advance(&mut observer, part);
                }
                assert_eq!(observer.observed, input);
                assert_eq!(observer.printed, ['a', 'b', 'c']);
                assert_eq!(
                    observer.commands,
                    [(b"Ga=T,f=32;AAAA".to_vec(), Some(true)), (b"unknown".to_vec(), Some(true)),]
                );
                assert!(!parser.control_pending());
            }
        }
    }

    #[test]
    fn apc_cancellation_never_commits_and_recovers_following_controls() {
        let fixtures: &[&[u8]] = &[
            b"\x1b_Gpending\x18\x1b_Gvalid\x1b\\x",
            b"\x1b_Gpending\x1a\x1b_Gvalid\x1b\\x",
            b"\x1b_Gpending\x1b_Gvalid\x1b\\x",
            b"\x1b_Gpending\x1b[31m\x1b_Gvalid\x1b\\x",
            b"\x1b_Gpending\x1b\x1b_Gvalid\x1b\\x",
        ];
        for input in fixtures {
            for split in 0..=input.len() {
                let mut parser = Parser::new();
                let mut observer = ApcObserver::default();
                parser.advance(&mut observer, &input[..split]);
                parser.advance(&mut observer, &input[split..]);
                assert_eq!(
                    observer.commands,
                    [(b"Gpending".to_vec(), Some(false)), (b"Gvalid".to_vec(), Some(true)),]
                );
                assert_eq!(observer.printed, ['x']);
                assert_eq!(&observer.observed, input);
                assert!(!parser.control_pending());
            }
        }
    }

    #[test]
    fn apc_payload_is_opaque_batched_and_not_an_osc_or_dcs() {
        let mut parser = Parser::new();
        let mut observer = ApcObserver::default();
        let input = b"\x1bPqGnot-apc\x1b\\\x1b]Gnot-apc\x07\x1b^Gnot-apc\x1b\\\x1bXGnot-apc\x1b\\\x1b_G\x00\x07\x9c\xc2\x9c\xff;data\x1b\\";
        parser.advance(&mut observer, input);
        assert_eq!(observer.commands, [(b"G\x00\x07\x9c\xc2\x9c\xff;data".to_vec(), Some(true))]);
        assert_eq!(observer.observed, input);
        assert_eq!(observer.payload_calls, 1);
        assert!(observer.executed.is_empty());
        assert!(observer.printed.is_empty());
    }

    #[test]
    fn apc_incomplete_terminator_keeps_ownership_without_commit() {
        let mut parser = Parser::new();
        let mut observer = ApcObserver::default();
        parser.advance(&mut observer, b"\x1b_Gdata\x1b");
        parser.advance(&mut observer, b"");
        assert_eq!(observer.commands, [(b"Gdata".to_vec(), None)]);
        assert!(parser.control_pending());
        parser.advance(&mut observer, b"\\");
        assert_eq!(observer.commands[0].1, Some(true));
        assert!(!parser.control_pending());
    }

    #[test]
    fn apc_can_suspend_exactly_after_commit_before_following_query() {
        let input = b"\x1b_Ga=q,i=1;AAAA\x1b\\\x1b[cafter";
        let boundary = input.len() - b"\x1b[cafter".len();
        for split in 0..=boundary {
            let mut parser = Parser::new();
            let mut observer = ApcObserver { stop_at_end: true, ..Default::default() };
            let first = parser.advance_until_terminated(&mut observer, &input[..split]);
            let second = parser.advance_until_terminated(&mut observer, &input[first..]);
            assert_eq!(first + second, boundary);
            assert_eq!(observer.observed, input[..boundary]);
            assert!(observer.printed.is_empty());
            assert_eq!(parser.advance_until_terminated(&mut observer, &input[boundary..]), 0);
            observer.stopped = false;
            assert_eq!(
                parser.advance_until_terminated(&mut observer, &input[boundary..]),
                input.len() - boundary
            );
            assert_eq!(observer.observed, input);
            assert_eq!(observer.printed, ['a', 'f', 't', 'e', 'r']);
        }
    }

    #[test]
    fn application_observer_receives_each_consumed_byte_once() {
        #[derive(Default)]
        struct Observer(Vec<u8>);
        impl Perform for Observer {
            fn observe_application_bytes(&mut self, bytes: &[u8]) {
                self.0.extend_from_slice(bytes);
            }
        }

        let fixtures: &[&[u8]] = &[
            b"plain\r\n\t\x1b[2;3Hposition\x1b]133;B\x07tail",
            b"\x1bP1;2qpayload\x1b\\\x1b_Xignored\x1b\\end",
            "abc\u{0085}é🌍終\u{009b}end".as_bytes(),
            b"\xf0\x9f\x80\x1b[H\xff\xc2\x9d133;B\x9c\xe2x\x80end\xf0\x9f",
        ];
        for fixture in fixtures {
            for first in 0..=fixture.len() {
                for second in first..=fixture.len() {
                    let mut parser = Parser::new();
                    let mut observer = Observer::default();
                    for chunk in [&fixture[..first], &fixture[first..second], &fixture[second..]] {
                        parser.advance(&mut observer, chunk);
                    }
                    assert_eq!(&observer.0, fixture, "cuts {first}/{second}");
                }
            }
        }
    }

    const OSC_BYTES: &[u8] = &[
        0x1B, 0x5D, // Begin OSC
        b'2', b';', b'j', b'w', b'i', b'l', b'm', b'@', b'j', b'w', b'i', b'l', b'm', b'-', b'd',
        b'e', b's', b'k', b':', b' ', b'~', b'/', b'c', b'o', b'd', b'e', b'/', b'a', b'l', b'a',
        b'c', b'r', b'i', b't', b't', b'y', 0x07, // End OSC
    ];

    #[derive(Default)]
    struct Dispatcher {
        dispatched: Vec<Sequence>,
    }

    #[derive(Debug, PartialEq, Eq)]
    enum Sequence {
        Osc(Vec<Vec<u8>>, bool),
        Csi(Vec<Vec<u16>>, Vec<u8>, bool, char),
        Esc(Vec<u8>, bool, u8),
        DcsHook(Vec<Vec<u16>>, Vec<u8>, bool, char),
        DcsPut(u8),
        Print(char),
        Execute(u8),
        DcsUnhook,
    }

    impl Perform for Dispatcher {
        fn osc_dispatch(&mut self, params: &[&[u8]], bell_terminated: bool) {
            let params = params.iter().map(|p| p.to_vec()).collect();
            self.dispatched.push(Sequence::Osc(params, bell_terminated));
        }

        fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, c: char) {
            let params = params.iter().map(|subparam| subparam.to_vec()).collect();
            let intermediates = intermediates.to_vec();
            self.dispatched.push(Sequence::Csi(params, intermediates, ignore, c));
        }

        fn esc_dispatch(&mut self, intermediates: &[u8], ignore: bool, byte: u8) {
            let intermediates = intermediates.to_vec();
            self.dispatched.push(Sequence::Esc(intermediates, ignore, byte));
        }

        fn hook(&mut self, params: &Params, intermediates: &[u8], ignore: bool, c: char) {
            let params = params.iter().map(|subparam| subparam.to_vec()).collect();
            let intermediates = intermediates.to_vec();
            self.dispatched.push(Sequence::DcsHook(params, intermediates, ignore, c));
        }

        fn put(&mut self, byte: u8) {
            self.dispatched.push(Sequence::DcsPut(byte));
        }

        fn unhook(&mut self) {
            self.dispatched.push(Sequence::DcsUnhook);
        }

        fn print(&mut self, c: char) {
            self.dispatched.push(Sequence::Print(c));
        }

        fn execute(&mut self, byte: u8) {
            self.dispatched.push(Sequence::Execute(byte));
        }
    }

    /// Deterministic pseudo-random generator, so a failure is reproducible.
    fn lcg(state: &mut u32) -> usize {
        *state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (*state >> 16) as usize
    }

    /// A ground-state stream mixing every class the run splitter has to cut on.
    fn ground_corpus(state: &mut u32, out: &mut String) {
        let alphabet = [
            "a",
            "Z",
            "0",
            " ",
            "~",
            "!",
            "\u{7f}", // Printable ASCII and DEL.
            "\u{0}",
            "\u{7}",
            "\u{a}",
            "\u{d}",
            "\u{1f}", // C0.
            "\u{80}",
            "\u{9b}",
            "\u{9f}", // C1: two bytes, 0xC2-led.
            "\u{a0}",
            "\u{c2}",
            "\u{ff}", // Latin-1: also 0xC2-led, but printable.
            "\u{4e00}",
            "\u{1f600}",
            "\u{301}", // Three- and four-byte, and combining.
        ];
        out.clear();
        for _ in 0..=(lcg(state) % 32) {
            out.push_str(alphabet[lcg(state) % alphabet.len()]);
        }
    }

    /// ASCII runs and individually decoded characters must classify exactly as
    /// a per-character print/execute loop, including Latin-1, C1 and continuation
    /// bytes that must never be mistaken for controls.
    #[test]
    fn ground_run_split_matches_per_character_classification() {
        let mut state = 0x1357_9bdfu32;
        let mut text = String::new();

        for step in 0..4_000 {
            ground_corpus(&mut state, &mut text);

            let mut expected = Vec::new();
            for c in text.chars() {
                match c {
                    '\x00'..='\x1f' | '\u{80}'..='\u{9f}' => {
                        expected.push(Sequence::Execute(c as u8))
                    },
                    _ => expected.push(Sequence::Print(c)),
                }
            }

            let mut dispatcher = Dispatcher::default();
            let mut parser = Parser::new();
            parser.advance(&mut dispatcher, text.as_bytes());

            assert_eq!(
                dispatcher.dispatched, expected,
                "step {step}: dispatch diverged for {text:?}",
            );
        }
    }

    /// The old from_utf8 + ground_dispatch semantics, independent of the new decoder.
    fn reference_dispatch(performer: &mut Recorder, text: &str) {
        for c in text.chars() {
            let mut bytes = [0; 4];
            performer.observe_application_bytes(c.encode_utf8(&mut bytes).as_bytes());
            match c {
                '\x00'..='\x1f' | '\u{80}'..='\u{9f}' => performer.execute(c as u8),
                _ => performer.print(c),
            }
        }
    }

    fn reference_ground(parser: &mut Parser, performer: &mut Recorder, bytes: &[u8]) -> usize {
        // Find the next escape character.
        let num_bytes = bytes.len();
        let plain_chars = bytes.iter().position(|&byte| byte == 0x1B).unwrap_or(num_bytes);

        // If the next character is ESC, just process it and short-circuit.
        if plain_chars == 0 {
            performer.observe_application_bytes(&bytes[..1]);
            return 1 + parser.escape_from_ground(performer, &bytes[1..]);
        }

        let mut start = 0;
        loop {
            match str::from_utf8(&bytes[start..plain_chars]) {
                Ok(parsed) => {
                    reference_dispatch(performer, parsed);
                    let processed = plain_chars;

                    // If there's another character, it must be escape so process it directly.
                    if processed < num_bytes {
                        performer.observe_application_bytes(&bytes[processed..processed + 1]);
                        return processed
                            + 1
                            + parser.escape_from_ground(performer, &bytes[processed + 1..]);
                    }

                    return processed;
                },
                // Handle invalid and partial utf8.
                Err(err) => {
                    // Dispatch all the valid bytes.
                    let valid_bytes = start + err.valid_up_to();
                    let parsed = str::from_utf8(&bytes[start..valid_bytes]).unwrap();
                    reference_dispatch(performer, parsed);

                    match err.error_len() {
                        Some(len) => {
                            performer
                                .observe_application_bytes(&bytes[valid_bytes..valid_bytes + len]);
                            // Execute C1 escapes or emit replacement character.
                            if len == 1 && bytes[valid_bytes] <= 0x9F {
                                performer.execute(bytes[valid_bytes]);
                            } else {
                                performer.print('�');
                            }

                            // Continue after the invalid bytes up to the escape
                            // already found, without searching for it again.
                            start = valid_bytes + len;
                        },
                        None => {
                            if plain_chars < num_bytes {
                                performer.observe_application_bytes(
                                    &bytes[valid_bytes..plain_chars + 1],
                                );
                                // Process bytes cut off by escape.
                                performer.print('�');
                                parser.start_escape(performer);
                                return plain_chars + 1;
                            } else {
                                performer.observe_application_bytes(&bytes[valid_bytes..]);
                                // Process bytes cut off by the buffer end.
                                let extra_bytes = num_bytes - valid_bytes;
                                let partial_len = parser.partial_utf8_len + extra_bytes;
                                parser.partial_utf8[parser.partial_utf8_len..partial_len]
                                    .copy_from_slice(
                                        &bytes[valid_bytes..valid_bytes + extra_bytes],
                                    );
                                parser.partial_utf8_len = partial_len;
                                return num_bytes;
                            }
                        },
                    }
                },
            }
        }
    }

    #[test]
    fn ground_classification_matches_from_utf8_reference() {
        let edges = "\u{80}\u{9f}\u{a0}\u{7ff}\u{800}\u{d7ff}\u{e000}\u{ffff}\u{10000}\u{10ffff}";
        let malformed: &[&[u8]] = &[
            b"\xc0\x80",
            b"\xc1\xbf",
            b"\xe0\x80\x80",
            b"\xed\xa0\x80",
            b"\xf0\x80\x80\x80",
            b"\xf4\x90\x80\x80",
            b"\xf5\x80\x80\x80",
        ];
        let mut state = 0x5A17_C4E3;
        for corpus in 0..20_480 {
            let mut input = Vec::new();
            for fragment in 0..1 + lcg(&mut state) % 12 {
                let kind = if fragment == 0 { 0 } else { lcg(&mut state) % 8 };
                match kind {
                    0..=2 => {
                        // Every lead with every suffix length, repeatedly, plus
                        // random representatives of each possible byte class.
                        input.push(0x80 + (corpus % 128) as u8);
                        for _ in 0..(corpus / 128) % 4 {
                            let byte = match lcg(&mut state) % 5 {
                                0 => (lcg(&mut state) % 32) as u8,
                                1 => 0x20 + (lcg(&mut state) % 95) as u8,
                                2 => 0x7F,
                                3 => 0x80 + (lcg(&mut state) % 64) as u8,
                                _ => 0xC0 + (lcg(&mut state) % 64) as u8,
                            };
                            // Keep ESC followed by ordinary text, avoiding
                            // other escape grammars covered by control tests.
                            input.push(byte);
                            if byte == 0x1B {
                                input.extend_from_slice(b"Qtext");
                            }
                        }
                    },
                    3 => input.extend_from_slice(edges.as_bytes()),
                    4 => input.extend_from_slice(malformed[lcg(&mut state) % malformed.len()]),
                    5 => input.extend_from_slice(b"\x7f\x00\x1f\xc2\x80\xc2\x9f"),
                    6 => input.extend_from_slice(b"\x1bQtext"),
                    _ => {
                        let len = 1 + lcg(&mut state) % 64;
                        input.extend(core::iter::repeat(b'x').take(len));
                    },
                }
            }

            let mut reference = Parser::new();
            let mut expected = Recorder::default();
            let mut offset = 0;
            while offset < input.len() {
                if reference.state == State::Ground {
                    offset += reference_ground(&mut reference, &mut expected, &input[offset..]);
                } else {
                    reference.advance(&mut expected, &input[offset..offset + 1]);
                    offset += 1;
                }
            }
            assert_eq!(expected.observed, input, "reference observation {corpus}");
            normalize_ground_observation(&mut expected.events);

            for mode in 0..3 {
                let mut parser = Parser::new();
                let mut actual = Recorder::default();
                let mut offset = 0;
                while offset < input.len() {
                    let len = match mode {
                        0 => input.len(),
                        1 => 1 + lcg(&mut state) % 31,
                        _ => 1,
                    };
                    let end = (offset + len).min(input.len());
                    parser.advance(&mut actual, &input[offset..end]);
                    assert_eq!(actual.observed, input[..end], "observation {corpus}/{mode}");
                    offset = end;
                }
                normalize_ground_observation(&mut actual.events);
                assert_eq!(actual.events, expected.events, "corpus {corpus}/{mode}: {input:02x?}");
                assert_eq!(parser.state, reference.state, "state {corpus}/{mode}");
                assert_eq!(
                    &parser.partial_utf8[..parser.partial_utf8_len],
                    &reference.partial_utf8[..reference.partial_utf8_len],
                    "partial {corpus}/{mode}",
                );
            }
        }
    }

    /// Non-empty printable ASCII runs, prints and executes reconstruct the input.
    /// Adjacent ASCII runs would mean classification stopped before the run ended.
    #[test]
    fn print_str_runs_are_nonempty_printable_ascii_and_lossless() {
        #[derive(Default)]
        struct RunRecorder {
            rebuilt: String,
            runs: Vec<bool>,
        }

        impl Perform for RunRecorder {
            fn print(&mut self, c: char) {
                assert!(!matches!(c, ' '..='~'), "ASCII outside a run: {c:?}");
                self.rebuilt.push(c);
                self.runs.push(false);
            }

            fn print_str(&mut self, s: &str) {
                assert!(!s.is_empty(), "empty run");
                assert!(s.bytes().all(|byte| matches!(byte, 0x20..=0x7E)), "run {s:?}");
                self.rebuilt.push_str(s);
                self.runs.push(true);
            }

            fn execute(&mut self, byte: u8) {
                self.rebuilt.push(char::from(byte));
                self.runs.push(false);
            }
        }

        let mut state = 0x0f1e_2d3cu32;
        let mut text = String::new();

        for step in 0..4_000 {
            ground_corpus(&mut state, &mut text);

            let mut recorder = RunRecorder::default();
            let mut parser = Parser::new();
            parser.advance(&mut recorder, text.as_bytes());

            assert_eq!(recorder.rebuilt, text, "step {step}: run split lost bytes");
            assert!(
                !recorder.runs.windows(2).any(|pair| pair[0] && pair[1]),
                "step {step}: adjacent runs, so the split is not maximal, for {text:?}",
            );
        }
    }

    #[test]
    fn parse_osc() {
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, OSC_BYTES);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Osc(params, _) => {
                assert_eq!(params.len(), 2);
                assert_eq!(params[0], &OSC_BYTES[2..3]);
                assert_eq!(params[1], &OSC_BYTES[4..(OSC_BYTES.len() - 1)]);
            },
            _ => panic!("expected osc sequence"),
        }
    }

    #[test]
    fn parse_empty_osc() {
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, &[0x1B, 0x5D, 0x07]);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Osc(..) => (),
            _ => panic!("expected osc sequence"),
        }
    }

    #[test]
    fn completed_and_cancelled_osc_erase_the_retained_raw_storage() {
        for terminator in [&b"\x07"[..], &b"\x18"[..], &b"\x1b\\"[..]] {
            let mut parser = Parser::new();
            let mut dispatcher = Dispatcher::default();
            parser.advance(&mut dispatcher, b"\x1b]52;c;c2VjcmV0");
            let length = parser.osc_raw.len();
            let storage = parser.osc_raw.as_ptr();
            parser.advance(&mut dispatcher, terminator);
            assert!(parser.osc_raw.is_empty());
            // SAFETY: OSC completion clears without reallocating this buffer.
            // These length bytes were initialized before the terminator, and
            // remain allocated until the parser drops at the end of the loop.
            let retired = unsafe { core::slice::from_raw_parts(storage, length) };
            assert!(retired.iter().all(|byte| *byte == 0));
        }
    }

    #[test]
    fn cancelled_osc_never_dispatches_and_split_st_is_complete_only_at_backslash() {
        for cancel in [0x18, 0x1a] {
            let mut parser = Parser::new();
            let mut dispatcher = Dispatcher::default();
            parser.advance(&mut dispatcher, b"\x1b]52;c;secret");
            parser.advance(&mut dispatcher, &[cancel]);
            assert!(!dispatcher.dispatched.iter().any(|seq| matches!(seq, Sequence::Osc(..))));
        }
        let mut parser = Parser::new();
        let mut dispatcher = Dispatcher::default();
        parser.advance(&mut dispatcher, b"\x1b]9;ready\x1b");
        assert!(dispatcher.dispatched.is_empty());
        parser.advance(&mut dispatcher, b"\\");
        assert!(matches!(&dispatcher.dispatched[0], Sequence::Osc(params, false) if params == &[b"9".to_vec(), b"ready".to_vec()]));
    }

    #[cfg(feature = "std")]
    #[test]
    fn an_oversized_osc_is_cancelled_without_growing_the_accumulator() {
        let mut parser = Parser::new();
        let mut dispatcher = Dispatcher::default();
        parser.advance(&mut dispatcher, b"\x1b]2;");
        parser.advance(&mut dispatcher, &vec![b'x'; MAX_OSC_STRING_BYTES + 1]);
        assert_eq!(parser.osc_raw.len(), MAX_OSC_STRING_BYTES);
        assert!(parser.ignoring);
        parser.advance(&mut dispatcher, b"\x07");
        assert!(!dispatcher.dispatched.iter().any(|seq| matches!(seq, Sequence::Osc(..))));
        parser.advance(&mut dispatcher, b"\x1b]2;valid\x07");
        assert!(matches!(dispatcher.dispatched.last(), Some(Sequence::Osc(params, true)) if params == &[b"2".to_vec(), b"valid".to_vec()]));
    }

    #[test]
    fn parse_osc_max_params() {
        let params = ";".repeat(params::MAX_PARAMS + 1);
        let input = format!("\x1b]{}\x07", &params[..]).into_bytes();
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, &input);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Osc(params, _) => {
                assert_eq!(params.len(), MAX_OSC_PARAMS);
                assert!(params[..MAX_OSC_PARAMS - 1].iter().all(Vec::is_empty));
                assert_eq!(params[MAX_OSC_PARAMS - 1], vec![b';'; params::MAX_PARAMS + 2 - MAX_OSC_PARAMS]);
            },
            _ => panic!("expected osc sequence"),
        }
    }

    #[test]
    fn osc_bell_terminated() {
        const INPUT: &[u8] = b"\x1b]11;ff/00/ff\x07";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Osc(_, true) => (),
            _ => panic!("expected osc with bell terminator"),
        }
    }

    #[test]
    fn osc_c0_st_terminated() {
        const INPUT: &[u8] = b"\x1b]11;ff/00/ff\x1b\\";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 2);
        match &dispatcher.dispatched[0] {
            Sequence::Osc(_, false) => (),
            _ => panic!("expected osc with ST terminator"),
        }
    }

    #[test]
    fn parse_osc_with_utf8_arguments() {
        const INPUT: &[u8] = &[
            0x0D, 0x1B, 0x5D, 0x32, 0x3B, 0x65, 0x63, 0x68, 0x6F, 0x20, 0x27, 0xC2, 0xAF, 0x5C,
            0x5F, 0x28, 0xE3, 0x83, 0x84, 0x29, 0x5F, 0x2F, 0xC2, 0xAF, 0x27, 0x20, 0x26, 0x26,
            0x20, 0x73, 0x6C, 0x65, 0x65, 0x70, 0x20, 0x31, 0x07,
        ];
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched[0], Sequence::Execute(b'\r'));
        let osc_data = INPUT[5..(INPUT.len() - 1)].into();
        assert_eq!(dispatcher.dispatched[1], Sequence::Osc(vec![vec![b'2'], osc_data], true));
        assert_eq!(dispatcher.dispatched.len(), 2);
    }

    #[test]
    fn osc_containing_string_terminator() {
        const INPUT: &[u8] = b"\x1b]2;\xe6\x9c\xab\x1b\\";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 2);
        match &dispatcher.dispatched[0] {
            Sequence::Osc(params, _) => {
                assert_eq!(params[1], &INPUT[4..(INPUT.len() - 2)]);
            },
            _ => panic!("expected osc sequence"),
        }
    }

    #[test]
    fn exceed_max_buffer_size() {
        const NUM_BYTES: usize = MAX_OSC_RAW + 100;
        const INPUT_START: &[u8] = b"\x1b]52;s";
        const INPUT_END: &[u8] = b"\x07";

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        // Create valid OSC escape
        parser.advance(&mut dispatcher, INPUT_START);

        // Exceed max buffer size
        parser.advance(&mut dispatcher, &[b'a'; NUM_BYTES]);

        // Terminate escape for dispatch
        parser.advance(&mut dispatcher, INPUT_END);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Osc(params, _) => {
                assert_eq!(params.len(), 2);
                assert_eq!(params[0], b"52");

                #[cfg(feature = "std")]
                assert_eq!(params[1].len(), NUM_BYTES + INPUT_END.len());

                #[cfg(not(feature = "std"))]
                assert_eq!(params[1].len(), MAX_OSC_RAW - params[0].len());
            },
            _ => panic!("expected osc sequence"),
        }
    }

    #[test]
    fn parse_csi_max_params() {
        // This will build a list of repeating '1;'s
        // The length is MAX_PARAMS - 1 because the last semicolon is interpreted
        // as an implicit zero, making the total number of parameters MAX_PARAMS
        let params = "1;".repeat(params::MAX_PARAMS - 1);
        let input = format!("\x1b[{}p", &params[..]).into_bytes();

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, &input);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Csi(params, _, ignore, _) => {
                assert_eq!(params.len(), params::MAX_PARAMS);
                assert!(!ignore);
            },
            _ => panic!("expected csi sequence"),
        }
    }

    #[test]
    fn parse_csi_params_ignore_long_params() {
        // This will build a list of repeating '1;'s
        // The length is MAX_PARAMS because the last semicolon is interpreted
        // as an implicit zero, making the total number of parameters MAX_PARAMS + 1
        let params = "1;".repeat(params::MAX_PARAMS);
        let input = format!("\x1b[{}p", &params[..]).into_bytes();

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, &input);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Csi(params, _, ignore, _) => {
                assert_eq!(params.len(), params::MAX_PARAMS);
                assert!(ignore);
            },
            _ => panic!("expected csi sequence"),
        }
    }

    #[test]
    fn parse_csi_params_trailing_semicolon() {
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, b"\x1b[4;m");

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Csi(params, ..) => assert_eq!(params, &[[4], [0]]),
            _ => panic!("expected csi sequence"),
        }
    }

    #[test]
    fn parse_csi_params_leading_semicolon() {
        // Create dispatcher and check state
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, b"\x1b[;4m");

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Csi(params, ..) => assert_eq!(params, &[[0], [4]]),
            _ => panic!("expected csi sequence"),
        }
    }

    #[test]
    fn parse_long_csi_param() {
        // The important part is the parameter, which is (i64::MAX + 1)
        const INPUT: &[u8] = b"\x1b[9223372036854775808m";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Csi(params, ..) => assert_eq!(params, &[[u16::MAX]]),
            _ => panic!("expected csi sequence"),
        }
    }

    #[test]
    fn csi_reset() {
        const INPUT: &[u8] = b"\x1b[3;1\x1b[?1049h";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Csi(params, intermediates, ignore, _) => {
                assert_eq!(intermediates, b"?");
                assert_eq!(params, &[[1049]]);
                assert!(!ignore);
            },
            _ => panic!("expected csi sequence"),
        }
    }

    #[test]
    fn csi_subparameters() {
        const INPUT: &[u8] = b"\x1b[38:2:255:0:255;1m";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Csi(params, intermediates, ignore, _) => {
                assert_eq!(params, &[vec![38, 2, 255, 0, 255], vec![1]]);
                assert_eq!(intermediates, &[]);
                assert!(!ignore);
            },
            _ => panic!("expected csi sequence"),
        }
    }

    #[test]
    fn parse_dcs_max_params() {
        let params = "1;".repeat(params::MAX_PARAMS + 1);
        let input = format!("\x1bP{}p", &params[..]).into_bytes();
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, &input);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::DcsHook(params, _, ignore, _) => {
                assert_eq!(params.len(), params::MAX_PARAMS);
                assert!(params.iter().all(|param| param == &[1]));
                assert!(ignore);
            },
            _ => panic!("expected dcs sequence"),
        }
    }

    #[test]
    fn dcs_reset() {
        const INPUT: &[u8] = b"\x1b[3;1\x1bP1$tx\x9c";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 3);
        match &dispatcher.dispatched[0] {
            Sequence::DcsHook(params, intermediates, ignore, _) => {
                assert_eq!(intermediates, b"$");
                assert_eq!(params, &[[1]]);
                assert!(!ignore);
            },
            _ => panic!("expected dcs sequence"),
        }
        assert_eq!(dispatcher.dispatched[1], Sequence::DcsPut(b'x'));
        assert_eq!(dispatcher.dispatched[2], Sequence::DcsUnhook);
    }

    #[test]
    fn parse_dcs() {
        const INPUT: &[u8] = b"\x1bP0;1|17/ab\x9c";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 7);
        match &dispatcher.dispatched[0] {
            Sequence::DcsHook(params, _, _, c) => {
                assert_eq!(params, &[[0], [1]]);
                assert_eq!(c, &'|');
            },
            _ => panic!("expected dcs sequence"),
        }
        for (i, byte) in b"17/ab".iter().enumerate() {
            assert_eq!(dispatcher.dispatched[1 + i], Sequence::DcsPut(*byte));
        }
        assert_eq!(dispatcher.dispatched[6], Sequence::DcsUnhook);
    }

    #[test]
    fn intermediate_reset_on_dcs_exit() {
        const INPUT: &[u8] = b"\x1bP=1sZZZ\x1b+\x5c";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 6);
        match &dispatcher.dispatched[5] {
            Sequence::Esc(intermediates, ..) => assert_eq!(intermediates, b"+"),
            _ => panic!("expected esc sequence"),
        }
    }

    #[test]
    fn esc_reset() {
        const INPUT: &[u8] = b"\x1b[3;1\x1b(A";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Esc(intermediates, ignore, byte) => {
                assert_eq!(intermediates, b"(");
                assert_eq!(*byte, b'A');
                assert!(!ignore);
            },
            _ => panic!("expected esc sequence"),
        }
    }

    #[test]
    fn esc_reset_intermediates() {
        const INPUT: &[u8] = b"\x1b[?2004l\x1b#8";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 2);
        assert_eq!(dispatcher.dispatched[0], Sequence::Csi(vec![vec![2004]], vec![63], false, 'l'));
        assert_eq!(dispatcher.dispatched[1], Sequence::Esc(vec![35], false, 56));
    }

    #[test]
    fn params_buffer_filled_with_subparam() {
        const INPUT: &[u8] = b"\x1b[::::::::::::::::::::::::::::::::x\x1b";
        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Csi(params, intermediates, ignore, c) => {
                assert_eq!(intermediates, &[]);
                assert_eq!(params, &[[0; 32]]);
                assert_eq!(c, &'x');
                assert!(ignore);
            },
            _ => panic!("expected csi sequence"),
        }
    }

    #[cfg(not(feature = "std"))]
    #[test]
    fn build_with_fixed_size() {
        const INPUT: &[u8] = b"\x1b[3;1\x1b[?1049h";
        let mut dispatcher = Dispatcher::default();
        let mut parser: Parser<30> = Parser::new_with_size();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Csi(params, intermediates, ignore, _) => {
                assert_eq!(intermediates, b"?");
                assert_eq!(params, &[[1049]]);
                assert!(!ignore);
            },
            _ => panic!("expected csi sequence"),
        }
    }

    #[cfg(not(feature = "std"))]
    #[test]
    fn exceed_fixed_osc_buffer_size() {
        const OSC_BUFFER_SIZE: usize = 32;
        const NUM_BYTES: usize = OSC_BUFFER_SIZE + 100;
        const INPUT_START: &[u8] = b"\x1b]52;";
        const INPUT_END: &[u8] = b"\x07";

        let mut dispatcher = Dispatcher::default();
        let mut parser: Parser<OSC_BUFFER_SIZE> = Parser::new_with_size();

        // Create valid OSC escape
        parser.advance(&mut dispatcher, INPUT_START);

        // Exceed max buffer size
        parser.advance(&mut dispatcher, &[b'a'; NUM_BYTES]);

        // Terminate escape for dispatch
        parser.advance(&mut dispatcher, INPUT_END);

        assert_eq!(dispatcher.dispatched.len(), 1);
        match &dispatcher.dispatched[0] {
            Sequence::Osc(params, _) => {
                assert_eq!(params.len(), 2);
                assert_eq!(params[0], b"52");
                assert_eq!(params[1].len(), OSC_BUFFER_SIZE - params[0].len());
                for item in params[1].iter() {
                    assert_eq!(*item, b'a');
                }
            },
            _ => panic!("expected osc sequence"),
        }
    }

    #[cfg(not(feature = "std"))]
    #[test]
    fn fixed_size_osc_containing_string_terminator() {
        const INPUT_START: &[u8] = b"\x1b]2;";
        const INPUT_MIDDLE: &[u8] = b"s\xe6\x9c\xab";
        const INPUT_END: &[u8] = b"\x1b\\";

        let mut dispatcher = Dispatcher::default();
        let mut parser: Parser<5> = Parser::new_with_size();

        parser.advance(&mut dispatcher, INPUT_START);
        parser.advance(&mut dispatcher, INPUT_MIDDLE);
        parser.advance(&mut dispatcher, INPUT_END);

        assert_eq!(dispatcher.dispatched.len(), 2);
        match &dispatcher.dispatched[0] {
            Sequence::Osc(params, false) => {
                assert_eq!(params[0], b"2");
                assert_eq!(params[1], INPUT_MIDDLE);
            },
            _ => panic!("expected osc sequence"),
        }
    }

    #[test]
    fn unicode() {
        const INPUT: &[u8] = b"\xF0\x9F\x8E\x89_\xF0\x9F\xA6\x80\xF0\x9F\xA6\x80_\xF0\x9F\x8E\x89";

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 6);
        assert_eq!(dispatcher.dispatched[0], Sequence::Print('🎉'));
        assert_eq!(dispatcher.dispatched[1], Sequence::Print('_'));
        assert_eq!(dispatcher.dispatched[2], Sequence::Print('🦀'));
        assert_eq!(dispatcher.dispatched[3], Sequence::Print('🦀'));
        assert_eq!(dispatcher.dispatched[4], Sequence::Print('_'));
        assert_eq!(dispatcher.dispatched[5], Sequence::Print('🎉'));
    }

    #[test]
    fn invalid_utf8() {
        const INPUT: &[u8] = b"a\xEF\xBCb";

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 3);
        assert_eq!(dispatcher.dispatched[0], Sequence::Print('a'));
        assert_eq!(dispatcher.dispatched[1], Sequence::Print('�'));
        assert_eq!(dispatcher.dispatched[2], Sequence::Print('b'));
    }

    #[test]
    fn partial_utf8() {
        const INPUT: &[u8] = b"\xF0\x9F\x9A\x80";

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, &INPUT[..1]);
        parser.advance(&mut dispatcher, &INPUT[1..2]);
        parser.advance(&mut dispatcher, &INPUT[2..3]);
        parser.advance(&mut dispatcher, &INPUT[3..]);

        assert_eq!(dispatcher.dispatched.len(), 1);
        assert_eq!(dispatcher.dispatched[0], Sequence::Print('🚀'));
    }

    #[test]
    fn partial_utf8_separating_utf8() {
        // This is different from the `partial_utf8` test since it has a multi-byte UTF8
        // character after the partial UTF8 state, causing a partial byte to be present
        // in the `partial_utf8` buffer after the 2-byte codepoint.

        // "ĸ🎉"
        const INPUT: &[u8] = b"\xC4\xB8\xF0\x9F\x8E\x89";

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, &INPUT[..1]);
        parser.advance(&mut dispatcher, &INPUT[1..]);

        assert_eq!(dispatcher.dispatched.len(), 2);
        assert_eq!(dispatcher.dispatched[0], Sequence::Print('ĸ'));
        assert_eq!(dispatcher.dispatched[1], Sequence::Print('🎉'));
    }

    /// A character completed across reads must leave whatever follows it in
    /// the same read to the ordinary path: the four-byte completion window can
    /// hold a whole second character (here the space after `а`) before an
    /// incomplete third. A C1 control completed across reads is executed.
    #[test]
    fn ground_text_is_independent_of_every_pair_of_read_boundaries() {
        let fixtures: &[&[u8]] = &[
            "ица а 漢字 é ü".as_bytes(),
            "x\u{0085}y\u{009b}z é\u{0090}".as_bytes(),
            b"\xd0\xb0 \xe6\xbc\xa2\xd0\xb0\xe6\xbc",
        ];
        for fixture in fixtures {
            let mut whole = Dispatcher::default();
            Parser::new().advance(&mut whole, fixture);
            for first in 0..=fixture.len() {
                for second in first..=fixture.len() {
                    let mut parser = Parser::new();
                    let mut split = Dispatcher::default();
                    for chunk in [&fixture[..first], &fixture[first..second], &fixture[second..]] {
                        parser.advance(&mut split, chunk);
                    }
                    assert_eq!(split.dispatched, whole.dispatched, "cuts {first}/{second}");
                }
            }
        }
    }

    #[test]
    fn partial_invalid_utf8() {
        const INPUT: &[u8] = b"a\xEF\xBCb";

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, &INPUT[..1]);
        parser.advance(&mut dispatcher, &INPUT[1..2]);
        parser.advance(&mut dispatcher, &INPUT[2..3]);
        parser.advance(&mut dispatcher, &INPUT[3..]);

        assert_eq!(dispatcher.dispatched.len(), 3);
        assert_eq!(dispatcher.dispatched[0], Sequence::Print('a'));
        assert_eq!(dispatcher.dispatched[1], Sequence::Print('�'));
        assert_eq!(dispatcher.dispatched[2], Sequence::Print('b'));
    }

    #[test]
    fn partial_invalid_utf8_split() {
        const INPUT: &[u8] = b"\xE4\xBF\x99\xB5";

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, &INPUT[..2]);
        parser.advance(&mut dispatcher, &INPUT[2..]);

        assert_eq!(dispatcher.dispatched[0], Sequence::Print('俙'));
        assert_eq!(dispatcher.dispatched[1], Sequence::Print('�'));
    }

    #[test]
    fn partial_utf8_into_esc() {
        const INPUT: &[u8] = b"\xD8\x1b012";

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 4);
        assert_eq!(dispatcher.dispatched[0], Sequence::Print('�'));
        assert_eq!(dispatcher.dispatched[1], Sequence::Esc(Vec::new(), false, b'0'));
        assert_eq!(dispatcher.dispatched[2], Sequence::Print('1'));
        assert_eq!(dispatcher.dispatched[3], Sequence::Print('2'));
    }

    #[test]
    fn c1s() {
        const INPUT: &[u8] = b"\x00\x1f\x80\x90\x98\x9b\x9c\x9d\x9e\x9fa";

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 11);
        assert_eq!(dispatcher.dispatched[0], Sequence::Execute(0));
        assert_eq!(dispatcher.dispatched[1], Sequence::Execute(31));
        assert_eq!(dispatcher.dispatched[2], Sequence::Execute(128));
        assert_eq!(dispatcher.dispatched[3], Sequence::Execute(144));
        assert_eq!(dispatcher.dispatched[4], Sequence::Execute(152));
        assert_eq!(dispatcher.dispatched[5], Sequence::Execute(155));
        assert_eq!(dispatcher.dispatched[6], Sequence::Execute(156));
        assert_eq!(dispatcher.dispatched[7], Sequence::Execute(157));
        assert_eq!(dispatcher.dispatched[8], Sequence::Execute(158));
        assert_eq!(dispatcher.dispatched[9], Sequence::Execute(159));
        assert_eq!(dispatcher.dispatched[10], Sequence::Print('a'));
    }

    #[test]
    fn execute_anywhere() {
        const INPUT: &[u8] = b"\x18\x1a";

        let mut dispatcher = Dispatcher::default();
        let mut parser = Parser::new();

        parser.advance(&mut dispatcher, INPUT);

        assert_eq!(dispatcher.dispatched.len(), 2);
        assert_eq!(dispatcher.dispatched[0], Sequence::Execute(0x18));
        assert_eq!(dispatcher.dispatched[1], Sequence::Execute(0x1A));
    }
}
