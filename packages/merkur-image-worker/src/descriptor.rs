//! A descriptor conveys an extent, never ambient path authority. The helper
//! snapshots this extent into its confined arena before decoding it.

use merkur_graphics::processing::{DecodeRequest, MAX_INPUT_BYTES, REQUEST_BYTES};

/// Wire fact: one decode request and two little-endian u64 extent fields.
pub const REQUEST_LEN: usize = REQUEST_BYTES + 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    pub decode: DecodeRequest,
    pub offset: u64,
    pub length: u64,
}

impl Request {
    pub fn valid(self) -> bool {
        !self.decode.base64
            && self.decode.inflated_limit().is_some()
            && self.length > 0
            && self.length <= MAX_INPUT_BYTES as u64
            && self
                .offset
                .checked_add(self.length)
                .is_some_and(|end| end <= i64::MAX as u64)
    }

    pub fn encode(self) -> [u8; REQUEST_LEN] {
        let mut bytes = [0; REQUEST_LEN];
        bytes[..REQUEST_BYTES].copy_from_slice(&self.decode.encode());
        bytes[REQUEST_BYTES..REQUEST_BYTES + 8].copy_from_slice(&self.offset.to_le_bytes());
        bytes[REQUEST_BYTES + 8..].copy_from_slice(&self.length.to_le_bytes());
        bytes
    }

    pub fn decode(bytes: &[u8; REQUEST_LEN]) -> Option<Self> {
        let request = Self {
            decode: DecodeRequest::decode(bytes[..REQUEST_BYTES].try_into().ok()?)?,
            offset: u64::from_le_bytes(bytes[REQUEST_BYTES..REQUEST_BYTES + 8].try_into().ok()?),
            length: u64::from_le_bytes(bytes[REQUEST_BYTES + 8..].try_into().ok()?),
        };
        request.valid().then_some(request)
    }

    pub(crate) fn argument(self) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut argument = String::with_capacity(REQUEST_LEN * 2);
        for byte in self.encode() {
            argument.push(char::from(HEX[usize::from(byte >> 4)]));
            argument.push(char::from(HEX[usize::from(byte & 15)]));
        }
        argument
    }

    pub fn from_argument(argument: &str) -> Option<Self> {
        if argument.len() != REQUEST_LEN * 2 {
            return None;
        }
        let nibble = |b| match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            _ => None,
        };
        let mut bytes = [0; REQUEST_LEN];
        for (byte, pair) in bytes.iter_mut().zip(argument.as_bytes().chunks_exact(2)) {
            *byte = nibble(pair[0])? << 4 | nibble(pair[1])?;
        }
        Self::decode(&bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_graphics::command::Format;

    #[test]
    fn descriptor_extent_is_canonical_and_bounded() {
        let request = Request {
            decode: DecodeRequest {
                format: Format::Rgba,
                compressed: false,
                base64: false,
                width: 1,
                height: 1,
                inflated_bytes: 0,
            },
            offset: 19,
            length: 4,
        };
        assert_eq!(Request::decode(&request.encode()), Some(request));
        assert_eq!(Request::from_argument(&request.argument()), Some(request));
        for (offset, length) in [
            (0, 0),
            (0, MAX_INPUT_BYTES as u64 + 1),
            (u64::MAX, 4),
            (i64::MAX as u64, 1),
        ] {
            assert!(
                !Request {
                    offset,
                    length,
                    ..request
                }
                .valid()
            );
        }
        let mut encoded = request.encode();
        encoded[2] = 1;
        assert!(Request::decode(&encoded).is_none());
        encoded[2] = 0;
        encoded[23] = 1;
        assert!(Request::decode(&encoded).is_none());
        assert!(Request::from_argument(&format!("{}00", request.argument())).is_none());
    }
}
