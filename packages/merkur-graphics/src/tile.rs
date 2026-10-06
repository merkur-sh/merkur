//! Committed RGBA8 PNG tiles. Verification is independent of scene authority.
//!
//! The decoder receives a single bounded IHDR/IDAT/IEND image, without metadata,
//! animation, palettes or interlacing. The native decoder validates CRC/deflate.
pub const TILE_SIDE: usize = 256;
pub const TILE_GUTTER: usize = 1;
pub const TILE_STORED_SIDE: usize = TILE_SIDE + TILE_GUTTER * 2;
pub const TILE_RGBA_BYTES: usize = TILE_STORED_SIDE * TILE_STORED_SIDE * 4;
pub const TILE_ENCODED_BYTES: usize = 264 * 1024;
pub const VERIFY_CHUNK_BYTES: usize = 16 * 1024;
const PNG_OVERHEAD: usize = 57;
const DOMAIN: &[u8] = b"merkur.graphics.tile.png.rgba8.srgb.straight-alpha\0";
const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const END: &[u8] = b"\0\0\0\0IEND\xae\x42\x60\x82";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TileShape {
    width: u16,
    height: u16,
}

impl TileShape {
    pub fn new(width: u32, height: u32) -> Option<Self> {
        let valid = (1 + 2 * TILE_GUTTER) as u32..=TILE_STORED_SIDE as u32;
        (valid.contains(&width) && valid.contains(&height)).then_some(Self {
            width: width as u16,
            height: height as u16,
        })
    }
    pub fn width(self) -> u16 {
        self.width
    }
    pub fn height(self) -> u16 {
        self.height
    }
    pub fn stride(self) -> usize {
        usize::from(self.width) * 4
    }
    pub fn bytes(self) -> usize {
        self.stride() * usize::from(self.height)
    }
}

pub fn object_root(encoded: &[u8]) -> [u8; 32] {
    let mut hash = blake3::Hasher::new();
    hash.update(DOMAIN);
    hash.update(encoded);
    *hash.finalize().as_bytes()
}

struct Pending {
    total: usize,
    received: usize,
    shape: TileShape,
    root: [u8; 32],
    hash: blake3::Hasher,
    prefix: [u8; 41],
    tail: [u8; 12],
}

/// Allocation-free streaming commitment and envelope verification. Success permits
/// bounded native decoding; it neither validates deflate nor authorizes a scene.
#[derive(Default)]
pub struct TileVerifier {
    pending: Option<Pending>,
}

impl TileVerifier {
    pub fn clear(&mut self) {
        self.pending = None;
    }
    pub fn begin(&mut self, total: usize, shape: TileShape, root: [u8; 32]) -> bool {
        self.clear();
        if !(PNG_OVERHEAD + 1..=TILE_ENCODED_BYTES).contains(&total) {
            return false;
        }
        let mut hash = blake3::Hasher::new();
        hash.update(DOMAIN);
        self.pending = Some(Pending {
            total,
            received: 0,
            shape,
            root,
            hash,
            prefix: [0; 41],
            tail: [0; 12],
        });
        true
    }
    pub fn update(&mut self, bytes: &[u8]) -> bool {
        let Some(p) = &mut self.pending else {
            return false;
        };
        if bytes.is_empty() || bytes.len() > p.total - p.received {
            self.clear();
            return false;
        }
        let end = p.received + bytes.len();
        let prefix_end = end.min(p.prefix.len());
        if p.received < prefix_end {
            p.prefix[p.received..prefix_end].copy_from_slice(&bytes[..prefix_end - p.received]);
        }
        let tail_start = p.total - p.tail.len();
        let start = p.received.max(tail_start);
        if start < end {
            p.tail[start - tail_start..end - tail_start]
                .copy_from_slice(&bytes[start - p.received..]);
        }
        p.hash.update(bytes);
        p.received = end;
        true
    }
    pub fn finish(&mut self) -> bool {
        let Some(p) = self.pending.take() else {
            return false;
        };
        let b = p.prefix;
        p.received == p.total
            && p.hash.finalize().as_bytes() == &p.root
            && &b[..8] == SIGNATURE
            && &b[8..16] == b"\0\0\0\rIHDR"
            && b[16..20] == u32::from(p.shape.width).to_be_bytes()
            && b[20..24] == u32::from(p.shape.height).to_be_bytes()
            && b[24..29] == [8, 6, 0, 0, 0]
            && &b[37..41] == b"IDAT"
            && (u32::from_be_bytes([b[33], b[34], b[35], b[36]]) as usize).checked_add(PNG_OVERHEAD)
                == Some(p.total)
            && p.tail == END
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Deliberately not a valid deflate stream: envelope verification is not decoding.
    fn envelope() -> Vec<u8> {
        let mut b = vec![0; PNG_OVERHEAD + 4];
        b[..8].copy_from_slice(SIGNATURE);
        b[8..16].copy_from_slice(b"\0\0\0\rIHDR");
        b[16..20].copy_from_slice(&3u32.to_be_bytes());
        b[20..24].copy_from_slice(&3u32.to_be_bytes());
        b[24..29].copy_from_slice(&[8, 6, 0, 0, 0]);
        b[33..37].copy_from_slice(&4u32.to_be_bytes());
        b[37..41].copy_from_slice(b"IDAT");
        let end = b.len() - END.len();
        b[end..].copy_from_slice(END);
        b
    }

    #[test]
    fn every_split_and_single_bytes_verify_and_consume_owner() {
        let b = envelope();
        let shape = TileShape::new(3, 3).unwrap();
        let mut v = TileVerifier::default();
        for split in 1..b.len() {
            assert!(v.begin(b.len(), shape, object_root(&b)));
            assert!(v.update(&b[..split]));
            assert!(v.update(&b[split..]));
            assert!(v.finish());
            assert!(!v.finish());
            assert!(!v.update(&b));
        }
        assert!(v.begin(b.len(), shape, object_root(&b)));
        for byte in &b {
            assert!(v.update(std::slice::from_ref(byte)));
        }
        assert!(v.finish());
    }

    #[test]
    fn mutation_truncation_overflow_and_replacement_revoke() {
        let b = envelope();
        let shape = TileShape::new(3, 3).unwrap();
        let mut v = TileVerifier::default();
        for i in 0..b.len() {
            let mut corrupt = b.clone();
            corrupt[i] ^= 1;
            assert!(v.begin(b.len(), shape, object_root(&b)));
            assert!(v.update(&corrupt));
            assert!(!v.finish());
        }
        for i in (0..29).chain(33..41).chain(49..61) {
            let mut corrupt = b.clone();
            corrupt[i] ^= 1;
            assert!(v.begin(b.len(), shape, object_root(&corrupt)));
            assert!(v.update(&corrupt));
            assert!(!v.finish());
        }
        for end in 1..b.len() {
            assert!(v.begin(b.len(), shape, object_root(&b)));
            assert!(v.update(&b[..end]));
            assert!(!v.finish());
        }
        assert!(v.begin(b.len(), shape, object_root(&b)));
        assert!(!v.update(&vec![0; b.len() + 1]));
        assert!(!v.finish());
        assert!(v.begin(b.len(), shape, object_root(&b)));
        assert!(v.update(&b));
        assert!(!v.begin(usize::MAX, shape, [0; 32]));
        assert!(!v.finish());
        for (w, h) in [(0, 3), (3, 2), (259, 3), (65539, 3), (3, u32::MAX)] {
            assert!(TileShape::new(w, h).is_none());
        }
    }
}
