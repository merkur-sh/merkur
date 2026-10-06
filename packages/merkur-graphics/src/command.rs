//! Kitty control data, parsed independently of payload decoding.

/// Maximum encoded payload of one Kitty command, not of a whole image.
pub const MAX_CHUNK_BYTES: usize = 4096;
/// Resource bound: all supported unique keys with their largest values fit.
/// Repeated fields are rejected, rather than allowing ambiguous overrides, so
/// only a repeated key or a padded value can exceed it.
pub const MAX_HEADER_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    HeaderTooLarge,
    ChunkTooLarge,
    InvalidControl,
    DuplicateKey,
    UnsupportedKey,
    UnsupportedAction,
    UnsupportedMedium,
    UnsupportedFormat,
    UnsupportedCompression,
    InvalidContinuation,
    InvalidChunkLength,
    UploadTooLarge,
    ValidationPending,
    Cancelled,
    Retired,
    IdentityExhausted,
}

impl Error {
    /// Fixed printable ASCII; never include payloads or untrusted control data.
    /// Kitty answers data past its load buffer with EFBIG, the code of both data
    /// bounds. It has no header bound: a value past its ten digits makes a
    /// malformed control, so an oversized header answers as one, with EINVAL.
    pub const fn response(self) -> &'static str {
        match self {
            Self::ChunkTooLarge | Self::UploadTooLarge => "EFBIG:graphics data too large",
            Self::UnsupportedKey
            | Self::UnsupportedAction
            | Self::UnsupportedFormat
            | Self::UnsupportedCompression => "ENOTSUP:unsupported graphics control",
            Self::UnsupportedMedium => "ENOTSUP:inline graphics required",
            Self::ValidationPending => "EBUSY:graphics validation pending",
            Self::Cancelled | Self::Retired => "ECANCELED:graphics command cancelled",
            Self::IdentityExhausted => "EOVERFLOW:graphics identity exhausted",
            _ => "EINVAL:invalid graphics command",
        }
    }
}

/// Indices into fixed storage, including presence (zero is not absence).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Key {
    Action,
    Quiet,
    Medium,
    Format,
    Compression,
    Width,
    Height,
    Size,
    Offset,
    ImageId,
    ImageNumber,
    PlacementId,
    More,
    Delete,
    Columns,
    Rows,
    SourceX,
    SourceY,
    SourceWidth,
    SourceHeight,
    CellX,
    CellY,
    Z,
    Cursor,
    Virtual,
    ParentImage,
    ParentPlacement,
    ParentX,
    ParentY,
    UsageHints,
}

const KEY_COUNT: usize = Key::UsageHints as usize + 1;
const _: () = assert!(KEY_COUNT <= u32::BITS as usize);

impl Key {
    fn parse(byte: u8) -> Result<Self, Error> {
        Ok(match byte {
            b'a' => Self::Action,
            b'q' => Self::Quiet,
            b't' => Self::Medium,
            b'f' => Self::Format,
            b'o' => Self::Compression,
            b's' => Self::Width,
            b'v' => Self::Height,
            b'S' => Self::Size,
            b'O' => Self::Offset,
            b'i' => Self::ImageId,
            b'I' => Self::ImageNumber,
            b'p' => Self::PlacementId,
            b'm' => Self::More,
            b'd' => Self::Delete,
            b'c' => Self::Columns,
            b'r' => Self::Rows,
            b'x' => Self::SourceX,
            b'y' => Self::SourceY,
            b'w' => Self::SourceWidth,
            b'h' => Self::SourceHeight,
            b'X' => Self::CellX,
            b'Y' => Self::CellY,
            b'z' => Self::Z,
            b'C' => Self::Cursor,
            b'U' => Self::Virtual,
            b'P' => Self::ParentImage,
            b'Q' => Self::ParentPlacement,
            b'H' => Self::ParentX,
            b'V' => Self::ParentY,
            b'N' => Self::UsageHints,
            _ => return Err(Error::UnsupportedKey),
        })
    }

    const fn mask(self) -> u32 {
        1 << self as u32
    }

    const fn character(self) -> bool {
        matches!(
            self,
            Self::Action | Self::Medium | Self::Compression | Self::Delete
        )
    }

    const fn signed(self) -> bool {
        matches!(self, Self::Z | Self::ParentX | Self::ParentY)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Transmit,
    TransmitAndPlace,
    Place,
    Delete,
    Query,
    Frame,
    Animate,
    Compose,
}

impl Action {
    pub const fn transmits(self) -> bool {
        matches!(
            self,
            Self::Transmit | Self::TransmitAndPlace | Self::Query | Self::Frame
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Rgb,
    Rgba,
    Png,
}

/// A parsed control list. Action-specific semantic validation is still required.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Control {
    present: u32,
    values: [u32; KEY_COUNT],
}

impl Control {
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(Error::HeaderTooLarge);
        }
        let mut control = Self::default();
        if bytes.is_empty() {
            return Ok(control);
        }
        for field in bytes.split(|&byte| byte == b',') {
            if field.len() < 3 || field[1] != b'=' {
                return Err(Error::InvalidControl);
            }
            let key = Key::parse(field[0])?;
            if control.present & key.mask() != 0 {
                return Err(Error::DuplicateKey);
            }
            let value = &field[2..];
            let value = if key.character() {
                if value.len() != 1 || !value[0].is_ascii_alphabetic() {
                    return Err(Error::InvalidControl);
                }
                u32::from(value[0])
            } else {
                parse_number(value, key.signed())?
            };
            control.present |= key.mask();
            control.values[key as usize] = value;
        }
        Ok(control)
    }

    /// Signed fields return their two's-complement bits. Use `signed` for them.
    pub const fn get(&self, key: Key) -> Option<u32> {
        if self.present & key.mask() == 0 {
            None
        } else {
            Some(self.values[key as usize])
        }
    }

    /// The terminal fills the actual appended frame number only after publication.
    pub fn with_frame_reply(mut self, frame: u32) -> Self {
        self.present |= Key::Rows.mask();
        self.values[Key::Rows as usize] = frame;
        self
    }

    pub fn signed(&self, key: Key) -> Option<i32> {
        debug_assert!(key.signed());
        self.get(key).map(|value| value as i32)
    }

    pub fn action(&self) -> Result<Action, Error> {
        Ok(match self.get(Key::Action).unwrap_or(u32::from(b't')) {
            value if value == u32::from(b't') => Action::Transmit,
            value if value == u32::from(b'T') => Action::TransmitAndPlace,
            value if value == u32::from(b'p') => Action::Place,
            value if value == u32::from(b'd') => Action::Delete,
            value if value == u32::from(b'q') => Action::Query,
            value if value == u32::from(b'f') => Action::Frame,
            value if value == u32::from(b'a') => Action::Animate,
            value if value == u32::from(b'c') => Action::Compose,
            _ => return Err(Error::UnsupportedAction),
        })
    }

    pub fn format(&self) -> Result<Format, Error> {
        match self.get(Key::Format).unwrap_or(32) {
            24 => Ok(Format::Rgb),
            32 => Ok(Format::Rgba),
            100 => Ok(Format::Png),
            _ => Err(Error::UnsupportedFormat),
        }
    }

    /// Reject ambient file and shared-memory authority even for support probes.
    pub fn require_supported_medium(&self) -> Result<(), Error> {
        match self.get(Key::Medium) {
            None | Some(100 | 110) => Ok(()), // ASCII d / terminal-bound native reference n
            _ => Err(Error::UnsupportedMedium),
        }
    }

    pub fn native_reference(&self) -> bool {
        self.get(Key::Medium) == Some(u32::from(b'n'))
    }

    pub fn more(&self) -> Result<bool, Error> {
        match self.get(Key::More).unwrap_or(0) {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(Error::InvalidControl),
        }
    }

    pub fn quiet(&self) -> Result<u32, Error> {
        let quiet = self.get(Key::Quiet).unwrap_or(0);
        if quiet <= 2 {
            Ok(quiet)
        } else {
            Err(Error::InvalidControl)
        }
    }

    pub fn compressed(&self) -> Result<bool, Error> {
        match self.get(Key::Compression) {
            None => Ok(false),
            Some(122) => Ok(true), // ASCII z
            _ => Err(Error::UnsupportedCompression),
        }
    }

    pub(crate) fn continuation(&self, action: Action) -> bool {
        let mut allowed = Key::More.mask() | Key::Quiet.mask();
        if action == Action::Frame {
            allowed |= Key::Action.mask();
            if self.action() != Ok(Action::Frame) {
                return false;
            }
        }
        self.present & !allowed == 0 && self.get(Key::More).is_some()
    }

    pub(crate) fn with_quiet_from(mut self, continuation: &Self) -> Self {
        if let Some(quiet) = continuation.get(Key::Quiet) {
            self.values[Key::Quiet as usize] = quiet;
            self.present |= Key::Quiet.mask();
        }
        self
    }
}

fn parse_number(bytes: &[u8], signed: bool) -> Result<u32, Error> {
    let (negative, digits) = if signed && bytes.first() == Some(&b'-') {
        (true, &bytes[1..])
    } else {
        (false, bytes)
    };
    if digits.is_empty() {
        return Err(Error::InvalidControl);
    }
    let mut value = 0_u32;
    for &digit in digits {
        if !digit.is_ascii_digit() {
            return Err(Error::InvalidControl);
        }
        value = value
            .checked_mul(10)
            .and_then(|value| value.checked_add(u32::from(digit - b'0')))
            .ok_or(Error::InvalidControl)?;
    }
    if signed {
        if value > i32::MAX as u32 + u32::from(negative) {
            return Err(Error::InvalidControl);
        }
        if negative {
            value = value.wrapping_neg();
        }
    }
    Ok(value)
}

/// Borrowed, syntactically complete command. Its payload is still encoded and
/// unvalidated, so possession of this value grants no publication rights.
#[derive(PartialEq, Eq)]
pub struct Chunk<'a> {
    pub control: Control,
    pub payload: &'a [u8],
}

impl core::fmt::Debug for Chunk<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Chunk")
            .field("payload_bytes", &self.payload.len())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Received<'a> {
    Ignored,
    Cancelled,
    Rejected {
        error: Error,
        control: Option<Control>,
    },
    Chunk(Chunk<'a>),
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum State {
    #[default]
    Idle,
    Prefix,
    Header,
    Payload,
    Ignored,
    Rejected(Error),
}

/// One fixed-size staging area per active receiver. `push` performs bounded
/// copies only; the helper performs base64, decompression, and image decoding.
/// No size supplied by the application can grow either buffer.
pub struct Receiver {
    state: State,
    header: [u8; MAX_HEADER_BYTES],
    header_len: usize,
    payload: [u8; MAX_CHUNK_BYTES],
    payload_len: usize,
    control: Option<Control>,
}

impl Default for Receiver {
    fn default() -> Self {
        Self {
            state: State::Idle,
            header: [0; MAX_HEADER_BYTES],
            header_len: 0,
            payload: [0; MAX_CHUNK_BYTES],
            payload_len: 0,
            control: None,
        }
    }
}

impl Receiver {
    /// The command boundary retains this staging buffer until its owner accepts
    /// the chunk. Only `finish` classifies it; these bytes grant no authority.
    pub(crate) fn payload(&self) -> &[u8] {
        &self.payload[..self.payload_len]
    }

    pub fn start(&mut self) {
        self.state = State::Prefix;
        self.header_len = 0;
        self.payload_len = 0;
        self.control = None;
    }

    pub fn push(&mut self, mut bytes: &[u8]) {
        if self.state == State::Prefix {
            let Some((&prefix, rest)) = bytes.split_first() else {
                return;
            };
            self.state = if prefix == b'G' {
                State::Header
            } else {
                State::Ignored
            };
            bytes = rest;
        }
        if self.state == State::Header {
            // Look at only the remaining header allowance plus its possible
            // delimiter. A huge malformed APC cannot make header validation
            // scan its entire payload after the framing parser already did.
            let remaining = MAX_HEADER_BYTES - self.header_len;
            let scan = &bytes[..bytes.len().min(remaining + 1)];
            let end = scan
                .iter()
                .position(|&byte| byte == b';')
                .unwrap_or(scan.len());
            if end > remaining {
                self.state = State::Rejected(Error::HeaderTooLarge);
                return;
            }
            self.header[self.header_len..self.header_len + end].copy_from_slice(&bytes[..end]);
            self.header_len += end;
            if end == bytes.len() {
                return;
            }
            if let Err(error) = self.parse_header() {
                self.state = State::Rejected(error);
                return;
            }
            self.state = State::Payload;
            bytes = &bytes[end + 1..];
        }
        if self.state == State::Payload {
            if bytes.len() > MAX_CHUNK_BYTES - self.payload_len {
                self.state = State::Rejected(Error::ChunkTooLarge);
                return;
            }
            self.payload[self.payload_len..self.payload_len + bytes.len()].copy_from_slice(bytes);
            self.payload_len += bytes.len();
        }
    }

    fn parse_header(&mut self) -> Result<(), Error> {
        let control = Control::parse(&self.header[..self.header_len])?;
        self.control = Some(control);
        control.require_supported_medium()?;
        control.quiet()?;
        control.more()?;
        Ok(())
    }

    pub fn finish(&mut self, complete: bool) -> Received<'_> {
        let state = core::mem::take(&mut self.state);
        if matches!(state, State::Idle | State::Ignored | State::Prefix) {
            return Received::Ignored;
        }
        if !complete {
            return Received::Cancelled;
        }
        if let State::Rejected(error) = state {
            return Received::Rejected {
                error,
                control: self.control,
            };
        }
        if state == State::Header
            && let Err(error) = self.parse_header()
        {
            return Received::Rejected {
                error,
                control: self.control,
            };
        }
        match self.control {
            Some(control) => Received::Chunk(Chunk {
                control,
                payload: &self.payload[..self.payload_len],
            }),
            None => Received::Rejected {
                error: Error::InvalidControl,
                control: None,
            },
        }
    }
}
