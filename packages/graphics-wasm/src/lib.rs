//! Asset-worker commitment verification, separate from terminal and crypto memory.
use merkur_graphics::tile::{TileShape, TileVerifier, VERIFY_CHUNK_BYTES};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

#[wasm_bindgen]
pub struct GraphicsAssets {
    verifier: TileVerifier,
    manifest: Option<ManifestInput>,
    input: Box<[u8]>,
    root: [u8; 32],
}

#[wasm_bindgen]
impl GraphicsAssets {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            verifier: TileVerifier::default(),
            manifest: None,
            input: vec![0; VERIFY_CHUNK_BYTES].into_boxed_slice(),
            root: [0; 32],
        }
    }
    pub fn input_ptr(&self) -> *const u8 {
        self.input.as_ptr()
    }
    pub fn input_capacity(&self) -> usize {
        self.input.len()
    }
    pub fn root_ptr(&self) -> *const u8 {
        self.root.as_ptr()
    }
    pub fn begin(&mut self, length: usize, width: u32, height: u32) -> bool {
        self.manifest = None;
        self.verifier.clear();
        let Some(shape) = TileShape::new(width, height) else {
            return false;
        };
        self.verifier.begin(length, shape, self.root)
    }
    pub fn begin_manifest(&mut self, length: usize, width: u32, height: u32) -> bool {
        self.verifier.clear();
        self.manifest = None;
        if !(merkur_graphics::animation::HEADER_BYTES
            ..=merkur_graphics::animation::MAX_MANIFEST_BYTES)
            .contains(&length)
            || merkur_graphics::processing::pixel_bytes(width, height, 4).is_none()
        {
            return false;
        }
        self.manifest = Some(ManifestInput {
            bytes: Vec::with_capacity(length),
            length,
            width,
            height,
        });
        true
    }
    pub fn update(&mut self, length: usize) -> bool {
        let Some(input) = self.input.get(..length) else {
            self.verifier.clear();
            self.manifest = None;
            return false;
        };
        if let Some(manifest) = &mut self.manifest {
            if length == 0 || length > manifest.length - manifest.bytes.len() {
                self.manifest = None;
                return false;
            }
            manifest.bytes.extend_from_slice(input);
            return true;
        }
        self.verifier.update(input)
    }
    pub fn finish(&mut self) -> bool {
        if let Some(input) = self.manifest.take() {
            if input.bytes.len() != input.length {
                return false;
            }
            let budget = merkur_graphics::budget::Budget::new(
                merkur_graphics::animation::Manifest::charge(
                    merkur_graphics::animation::MAX_FRAMES,
                )
                .expect("manifest bound"),
            );
            return merkur_graphics::animation::Manifest::decode(&input.bytes, &budget)
                .is_some_and(|manifest| {
                    manifest.root() == self.root
                        && manifest.width() == input.width
                        && manifest.height() == input.height
                });
        }
        self.verifier.finish()
    }
}

struct ManifestInput {
    bytes: Vec<u8>,
    length: usize,
    width: u32,
    height: u32,
}
impl Drop for ManifestInput {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

impl Default for GraphicsAssets {
    fn default() -> Self {
        Self::new()
    }
}
impl Drop for GraphicsAssets {
    fn drop(&mut self) {
        self.input.zeroize();
        self.root.zeroize();
    }
}
