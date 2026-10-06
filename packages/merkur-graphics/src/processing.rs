//! Fixed, bounded IPC shared by the image worker and its trusted supervisor.
//! Neither side accepts paths, pointers, native structs, or decoder error text.

use crate::command::{Control, Error, Format, Key};

/// Resource bounds, not protocol limits. A terminal reserves these before work.
pub const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PIXELS: usize = 16 * 1024 * 1024;
pub const MAX_RGBA_BYTES: usize = MAX_PIXELS * 4;
pub const MAX_DIMENSION: u32 = 16384;
pub const REQUEST_BYTES: usize = 24;
pub const RESULT_BYTES: usize = 16;
pub const CHUNK_HEADER_BYTES: usize = 4;
/// The high bit marks the final chunk; all remaining bits are the byte length.
pub const FINAL_CHUNK: u32 = 1 << 31;
pub const WORKER_READY: [u8; 4] = *b"IMG!";

/// The failing stage a worker reports after its error marker, never decoder
/// metadata or image contents. Kitty answers each class with its own code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Rejection {
    Invalid = 0,
    /// Uncompressed raw pixels ended before their declared extent.
    Truncated = 1,
    /// The PNG stream failed to decode.
    Png = 2,
    /// More than the upload may hold: uncompressed raw pixels past their
    /// declared extent, or input past `MAX_INPUT_BYTES`.
    Excess = 3,
}

impl Rejection {
    pub fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            0 => Some(Self::Invalid),
            1 => Some(Self::Truncated),
            2 => Some(Self::Png),
            3 => Some(Self::Excess),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeRequest {
    pub format: Format,
    pub compressed: bool,
    pub base64: bool,
    pub width: u32,
    pub height: u32,
    pub inflated_bytes: u32,
}

impl DecodeRequest {
    pub fn from_control(control: &Control) -> Result<Self, Error> {
        Ok(Self {
            format: control.format()?,
            compressed: control.compressed()?,
            base64: true,
            width: control.get(Key::Width).unwrap_or(0),
            height: control.get(Key::Height).unwrap_or(0),
            inflated_bytes: control.get(Key::Size).unwrap_or(0),
        })
    }

    pub fn encode(self) -> [u8; REQUEST_BYTES] {
        let mut bytes = [0; REQUEST_BYTES];
        bytes[0] = match self.format {
            Format::Rgb => 24,
            Format::Rgba => 32,
            Format::Png => 100,
        };
        bytes[1] = u8::from(self.compressed);
        bytes[2] = u8::from(self.base64);
        bytes[4..8].copy_from_slice(&self.width.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.height.to_le_bytes());
        bytes[12..16].copy_from_slice(&self.inflated_bytes.to_le_bytes());
        bytes
    }

    pub fn decode(bytes: &[u8; REQUEST_BYTES]) -> Option<Self> {
        if bytes[1] > 1 || bytes[2] > 1 || bytes[3] != 0 || bytes[16..].iter().any(|&b| b != 0) {
            return None;
        }
        Some(Self {
            format: match bytes[0] {
                24 => Format::Rgb,
                32 => Format::Rgba,
                100 => Format::Png,
                _ => return None,
            },
            compressed: bytes[1] == 1,
            base64: bytes[2] == 1,
            width: u32::from_le_bytes(bytes[4..8].try_into().ok()?),
            height: u32::from_le_bytes(bytes[8..12].try_into().ok()?),
            inflated_bytes: u32::from_le_bytes(bytes[12..16].try_into().ok()?),
        })
    }

    pub fn inflated_limit(self) -> Option<usize> {
        match self.format {
            Format::Png if self.compressed => {
                let size = self.inflated_bytes as usize;
                (size > 0 && size <= MAX_INPUT_BYTES).then_some(size)
            }
            Format::Png => Some(MAX_INPUT_BYTES),
            Format::Rgb => pixel_bytes(self.width, self.height, 3),
            Format::Rgba => pixel_bytes(self.width, self.height, 4),
        }
    }
}

pub fn pixel_bytes(width: u32, height: u32, channels: usize) -> Option<usize> {
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        return None;
    }
    let pixels = (width as usize).checked_mul(height as usize)?;
    if pixels > MAX_PIXELS {
        return None;
    }
    pixels.checked_mul(channels)
}

/// Canonical pixels are straight-alpha RGBA8 in the sRGB colour space.
/// Construction validates hostile worker extents before bytes can be published.
pub struct Pixels {
    width: u32,
    height: u32,
    rgba: Box<[u8]>,
}

impl Pixels {
    pub fn new(width: u32, height: u32, rgba: Box<[u8]>) -> Option<Self> {
        (pixel_bytes(width, height, 4)? == rgba.len()).then_some(Self {
            width,
            height,
            rgba,
        })
    }
    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }
    pub fn rgba_mut(&mut self) -> &mut [u8] {
        &mut self.rgba
    }
    pub fn into_rgba(self) -> Box<[u8]> {
        self.rgba
    }
}

impl core::fmt::Debug for Pixels {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Pixels { .. }")
    }
}
