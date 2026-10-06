//! The browser samples the same immutable timeline implementation as the daemon.
use std::sync::LazyLock;

use merkur_graphics::{
    animation::{Manifest, Sample},
    budget::{Budget, Usage},
};
use wasm_bindgen::prelude::*;

// Lazy and independent of terminal/text storage. Retained manifests share one
// physical bound even when old renderer owners are still retiring.
static STORAGE: LazyLock<Budget> = LazyLock::new(|| {
    Budget::new(Usage {
        bytes: 16 * 1024 * 1024,
        objects: 3 * 4096,
    })
});

#[wasm_bindgen]
pub struct GraphicsAnimation {
    manifest: Manifest,
    sample: Sample,
}

#[wasm_bindgen]
impl GraphicsAnimation {
    pub fn parse(bytes: &[u8], root: &[u8], width: u32, height: u32) -> Option<Self> {
        let manifest = Manifest::decode(bytes, &STORAGE)?;
        if manifest.root() != root || manifest.width() != width || manifest.height() != height {
            return None;
        }
        let sample = manifest.sample(manifest.playback().anchor_us);
        Some(Self { manifest, sample })
    }

    /// The clock owner supplies native monotonic microseconds. Finite bounds
    /// avoid JavaScript's integer rounding above its exact representation range.
    pub fn sample(&mut self, now_us: f64) -> u32 {
        if now_us.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&now_us) {
            self.sample = self.manifest.sample(now_us as u64);
        }
        self.sample.frame
    }
    pub fn next_us(&self) -> f64 {
        self.sample.next_us.map_or(-1.0, |v| v as f64)
    }
    /// Preview the next boundary without advancing the currently sampled frame.
    pub fn next_frame(&self) -> i32 {
        self.sample
            .next_us
            .map_or(-1, |at| self.manifest.sample(at).frame as i32)
    }
    pub fn frame_count(&self) -> usize {
        self.manifest.entries().len()
    }
    pub fn frame_root(&self, frame: usize) -> Option<Vec<u8>> {
        self.manifest.entry(frame).map(|entry| entry.root.to_vec())
    }
}
