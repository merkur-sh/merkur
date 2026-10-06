//! Immutable source identity, independent of transfer tiles, encoding and LOD.
//!
//! The manifest is width:u32 | height:u32 | BLAKE3(canonical pixels):[u8;32],
//! with big-endian dimensions. Its root commits to these bytes and the exact
//! pixel interpretation. Neither a root nor a parsed manifest grants authority.

use crate::processing::{Pixels, pixel_bytes};
use crate::projection::Content;

/// Wire fact: two dimensions and one 256-bit canonical-pixel commitment.
pub const SOURCE_MANIFEST_BYTES: usize = 40;
const DOMAIN: &[u8] = b"merkur.graphics.source.rgba8.srgb.straight-alpha\0";

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct SourceManifest {
    bytes: [u8; SOURCE_MANIFEST_BYTES],
    root: [u8; 32],
}

impl SourceManifest {
    /// Linear work in source bytes. Call only on a bounded processing worker,
    /// after hostile output has become private immutable storage.
    pub fn from_pixels(pixels: &Pixels) -> Self {
        let mut bytes = [0; SOURCE_MANIFEST_BYTES];
        bytes[..4].copy_from_slice(&pixels.width().to_be_bytes());
        bytes[4..8].copy_from_slice(&pixels.height().to_be_bytes());
        bytes[8..].copy_from_slice(blake3::hash(pixels.rgba()).as_bytes());
        Self::from_bytes(bytes)
    }

    /// Shape validation only. The caller must authenticate the manifest and
    /// compare its commitment to the authorized row before using its pixels.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let bytes: [u8; SOURCE_MANIFEST_BYTES] = bytes.try_into().ok()?;
        pixel_bytes(word(&bytes, 0), word(&bytes, 4), 4)?;
        Some(Self::from_bytes(bytes))
    }

    fn from_bytes(bytes: [u8; SOURCE_MANIFEST_BYTES]) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(DOMAIN);
        hasher.update(&bytes);
        Self {
            bytes,
            root: *hasher.finalize().as_bytes(),
        }
    }

    pub fn encode(&self) -> &[u8; SOURCE_MANIFEST_BYTES] {
        &self.bytes
    }

    pub fn content(&self) -> Content {
        Content {
            kind: crate::projection::ContentKind::Image,
            root: self.root,
            width: word(&self.bytes, 0),
            height: word(&self.bytes, 4),
        }
    }
}

fn word(bytes: &[u8; SOURCE_MANIFEST_BYTES], offset: usize) -> u32 {
    u32::from_be_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed manifest field"),
    )
}

impl core::fmt::Debug for SourceManifest {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("SourceManifest { .. }")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_identity_binds_shape_pixels_and_interpretation() {
        let pixels = Pixels::new(2, 1, vec![1, 2, 3, 4, 5, 6, 7, 8].into_boxed_slice()).unwrap();
        let manifest = SourceManifest::from_pixels(&pixels);
        // Fixed byte-contract vector, independent of decoder/transfer format.
        assert_eq!(
            manifest.encode(),
            &[
                0, 0, 0, 2, 0, 0, 0, 1, 0xe5, 0x76, 0xe9, 0x4c, 0x11, 0xc5, 0x98, 0xaa, 0xd6, 0xac,
                0x78, 0x15, 0x01, 0x0f, 0x1c, 0x15, 0x25, 0xc2, 0x1d, 0xec, 0x54, 0xcf, 0x17, 0x7a,
                0x8b, 0xe6, 0xa6, 0x14, 0x2c, 0x7a, 0x39, 0xa4,
            ]
        );
        assert_eq!(
            manifest.content().root,
            [
                0x98, 0x5a, 0xc5, 0x9c, 0x79, 0x29, 0x03, 0x51, 0xd4, 0xe0, 0xe7, 0x00, 0xf7, 0x9f,
                0x9c, 0x87, 0xeb, 0x67, 0xe9, 0x11, 0xe9, 0xb4, 0xf3, 0x62, 0xfc, 0x56, 0x1a, 0x79,
                0x22, 0xae, 0xa0, 0xe1,
            ]
        );
        assert_eq!(SourceManifest::decode(manifest.encode()), Some(manifest));
        assert_eq!(manifest.content().width, 2);
        assert_eq!(manifest.content().height, 1);
        assert_ne!(
            manifest.content().root,
            *blake3::hash(manifest.encode()).as_bytes()
        );
        let reshaped = Pixels::new(1, 2, pixels.rgba().into()).unwrap();
        assert_ne!(manifest, SourceManifest::from_pixels(&reshaped));
        let mut changed = pixels.rgba().to_vec();
        changed[7] ^= 1;
        assert_ne!(
            manifest,
            SourceManifest::from_pixels(&Pixels::new(2, 1, changed.into()).unwrap())
        );
        assert_eq!(format!("{manifest:?}"), "SourceManifest { .. }");
    }

    #[test]
    fn malformed_source_domains_are_refused_before_allocation() {
        let pixels = Pixels::new(1, 1, vec![0; 4].into()).unwrap();
        let manifest = SourceManifest::from_pixels(&pixels);
        for length in 0..SOURCE_MANIFEST_BYTES {
            assert!(SourceManifest::decode(&manifest.encode()[..length]).is_none());
        }
        let mut trailing = manifest.encode().to_vec();
        trailing.push(0);
        assert!(SourceManifest::decode(&trailing).is_none());
        for (width, height) in [(0u32, 1u32), (1, 0), (u32::MAX, 1), (16384, 16384)] {
            let mut bytes = *manifest.encode();
            bytes[..4].copy_from_slice(&width.to_be_bytes());
            bytes[4..8].copy_from_slice(&height.to_be_bytes());
            assert!(SourceManifest::decode(&bytes).is_none());
        }
    }
}
