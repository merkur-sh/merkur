//! Browser measurement of the rejected zstd candidate, not application code.
pub mod tile;
use tile::{TILE_ENCODED_BYTES, TILE_RGBA_BYTES, TileDecoder, TileShape};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

#[wasm_bindgen]
pub struct GraphicsDecoder {
    decoder: TileDecoder,
    // Fixed extents: decoder calls cannot invalidate these pointers. Creating
    // another owner may grow linear memory, so JS must refresh detached views.
    input: Box<[u8]>,
    output: Box<[u8]>,
    root: [u8; 32],
}

#[wasm_bindgen]
impl GraphicsDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            decoder: TileDecoder::default(),
            input: vec![0; TILE_ENCODED_BYTES].into_boxed_slice(),
            output: vec![0; TILE_RGBA_BYTES].into_boxed_slice(),
            root: [0; 32],
        }
    }
    pub fn input_ptr(&self) -> *const u8 {
        self.input.as_ptr()
    }
    pub fn input_capacity(&self) -> usize {
        self.input.len()
    }
    pub fn output_ptr(&self) -> *const u8 {
        self.output.as_ptr()
    }
    pub fn output_capacity(&self) -> usize {
        self.output.len()
    }
    pub fn root_ptr(&self) -> *const u8 {
        self.root.as_ptr()
    }
    /// Expected object root is written to root_ptr. Negative means no output may
    /// be published. Shape comes from the authenticated, source-bound manifest.
    pub fn decode(&mut self, length: usize, width: u16, height: u16) -> i32 {
        let Some(shape) = TileShape::new(width, height) else {
            return -1;
        };
        let Some(input) = self.input.get(..length) else {
            return -1;
        };
        if self
            .decoder
            .decode(input, &self.root, shape, &mut self.output[..shape.bytes()])
            .is_err()
        {
            self.output.zeroize();
            return -1;
        }
        shape.bytes() as i32
    }
}

impl Default for GraphicsDecoder {
    fn default() -> Self {
        Self::new()
    }
}
impl Drop for GraphicsDecoder {
    fn drop(&mut self) {
        self.input.zeroize();
        self.output.zeroize();
        self.root.zeroize();
    }
}
