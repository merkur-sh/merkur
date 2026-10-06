//! Capture-side client arithmetic in the existing authorization WASM realm.
//! No grid or renderer is instantiated on main for speculative provenance.
use merkur_client::input_admission::{Mirror, Op, Snapshot};
use wasm_bindgen::prelude::*;

/// Whether a typed code point is one the speculative model may draw: one cell
/// by the grid's own width table. Main asks the core this rather than keeping
/// a table of its own, so its intent, the core's and the terminal's agree.
#[wasm_bindgen]
pub fn predictable_width_one(codepoint: u32) -> bool {
    merkur_client::viewer::predictable_width_one(codepoint)
}

#[wasm_bindgen]
pub struct ClientPredictionAdmission {
    inner: Mirror,
    snapshot: [u32; 7],
}

impl Default for ClientPredictionAdmission {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl ClientPredictionAdmission {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Mirror::default(),
            snapshot: [0; 7],
        }
    }

    /// Stable seven-word destination for the main-thread seqlock copy:
    /// armed/flags, start, cursor, end, remaining, columns, through-input.
    pub fn snapshot_ptr(&self) -> *const u32 {
        self.snapshot.as_ptr()
    }

    /// One allocation-free call after the main-thread SAB read.
    /// Visibility is independently latched in the command published to the
    /// terminal owner. A failed command publication must invalidate this model.
    pub fn prepare(&mut self, op: u8, input: u32, version: u32) -> bool {
        let Some(op) = Op::from_byte(op) else {
            self.inner.invalidate();
            return false;
        };
        self.inner.prepare(
            op,
            input,
            version,
            Snapshot {
                armed: self.snapshot[0] & (1 << 30) != 0,
                flags: self.snapshot[0] & !(1 << 30),
                start: self.snapshot[1],
                cursor: self.snapshot[2],
                end: self.snapshot[3],
                remaining: self.snapshot[4],
                cols: self.snapshot[5],
                through: self.snapshot[6],
            },
        )
    }
    pub fn invalidate(&mut self) {
        self.inner.invalidate();
    }
    pub fn flush(&mut self, input: u32) {
        self.inner.flush(input);
    }
    pub fn reset(&mut self) {
        self.inner.reset();
    }
}
