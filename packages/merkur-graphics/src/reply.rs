//! Bounded protocol replies. Only fixed ASCII errors and numeric identities are echoed.

use crate::command::{Action, Control, Error, Key};
use crate::geometry::GeometryError;
use crate::placements::PlacementError;
use crate::scene::SceneError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplyError {
    Protocol(Error),
    MissingImage,
    MissingParent,
    Cycle,
    TooDeep,
    Quota,
    Decode,
    /// Uncompressed raw pixels ended before their declared extent.
    Truncated,
    /// The PNG stream failed to decode.
    Png,
    Worker,
    GeometryUnavailable,
}

impl ReplyError {
    pub const fn message(self) -> &'static str {
        match self {
            Self::Protocol(error) => error.response(),
            Self::MissingImage => "ENOENT:image or frame does not exist",
            Self::MissingParent => "ENOPARENT:parent placement does not exist",
            Self::Cycle => "ECYCLE:placement dependency cycle",
            Self::TooDeep => "ETOODEEP:placement dependency depth",
            Self::Quota => "ENOSPC:graphics resource limit",
            Self::Decode => "EINVAL:invalid image data",
            Self::Truncated => "ENODATA:insufficient image data",
            Self::Png => "EBADPNG:invalid PNG data",
            Self::Worker => "EIO:image processing failed",
            Self::GeometryUnavailable => "EAGAIN:terminal pixel geometry unavailable",
        }
    }
}

impl From<SceneError> for ReplyError {
    fn from(error: SceneError) -> Self {
        match error {
            SceneError::Protocol(error) => Self::Protocol(error),
            SceneError::MissingImage => Self::MissingImage,
            SceneError::Quota => Self::Quota,
            SceneError::Stale => Self::Protocol(Error::Cancelled),
        }
    }
}

impl From<PlacementError> for ReplyError {
    fn from(error: PlacementError) -> Self {
        match error {
            PlacementError::MissingParent => Self::MissingParent,
            PlacementError::Cycle => Self::Cycle,
            PlacementError::TooDeep => Self::TooDeep,
            PlacementError::Quota => Self::Quota,
            PlacementError::IdentityExhausted => Self::Protocol(Error::IdentityExhausted),
        }
    }
}

impl From<GeometryError> for ReplyError {
    fn from(_: GeometryError) -> Self {
        Self::Protocol(Error::InvalidControl)
    }
}

/// Four u32 fields, fixed framing, and the longest fixed error fit in 128 bytes.
/// Payload bytes, paths, worker messages, and terminal text never enter this buffer.
pub struct Reply {
    bytes: [u8; 128],
    len: usize,
}

impl Reply {
    /// Call once at the semantic command result, never for an intermediate chunk.
    /// `image_id` is the owner-resolved identity for commands using an image number.
    pub fn new(
        control: &Control,
        image_id: Option<u32>,
        result: Result<(), ReplyError>,
    ) -> Option<Self> {
        let quiet = control.quiet().unwrap_or(0);
        if quiet == 2 || (quiet == 1 && result.is_ok()) {
            return None;
        }
        let image_id = image_id.or(control.get(Key::ImageId)).unwrap_or(0);
        let number = control.get(Key::ImageNumber).unwrap_or(0);
        if image_id == 0 && number == 0 {
            return None;
        }
        // Deletion and animation control never acknowledge success; frame
        // composition does, like transmission and placement.
        if result.is_ok() && matches!(control.action(), Ok(Action::Delete | Action::Animate)) {
            return None;
        }
        let mut reply = Self {
            bytes: [0; 128],
            len: 0,
        };
        reply.append(b"\x1b_G");
        if image_id != 0 {
            reply.field(b'i', image_id);
        }
        if number != 0 {
            reply.field(b'I', number);
        }
        if let Some(placement) = control.get(Key::PlacementId).filter(|id| *id != 0) {
            reply.field(b'p', placement);
        }
        if matches!(control.action(), Ok(Action::Frame | Action::Animate))
            && let Some(frame) = control.get(Key::Rows).filter(|frame| *frame != 0)
        {
            reply.field(b'r', frame);
        }
        reply.append(b";");
        reply.append(result.err().map_or("OK", ReplyError::message).as_bytes());
        reply.append(b"\x1b\\");
        Some(reply)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }

    fn append(&mut self, bytes: &[u8]) {
        let end = self.len + bytes.len();
        self.bytes[self.len..end].copy_from_slice(bytes);
        self.len = end;
    }

    fn field(&mut self, key: u8, mut value: u32) {
        if self.len != 3 {
            self.append(b",");
        }
        self.append(&[key, b'=']);
        let mut digits = [0; 10];
        let mut start = digits.len();
        loop {
            start -= 1;
            digits[start] = b'0' + (value % 10) as u8;
            value /= 10;
            if value == 0 {
                break;
            }
        }
        self.append(&digits[start..]);
    }
}
