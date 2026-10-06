//! The viewer half of the client core: what the browser's terminal worker does
//! between the transport and the renderer. It applies display frames to a
//! terminal grid, rebuilds lost ones from FEC, answers the daemon's row-hash
//! digest, keeps the selective display ACK and issues presentation grants;
//! dictionaries, input routing, epochs and presentation transactions build on
//! it.

// A latency path: the viewer waits on the event itself, never on a clock. `clippy.toml` lists
// the timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

pub mod ack_window;
pub mod demand;
mod fec;
pub mod graphics;
pub mod input_routing;
pub mod links;
pub mod playback;
mod prediction;
pub mod presentation;
pub mod receive;
mod repaint_hold;

pub use prediction::{
    MISMATCH_GRACE_MS, PredictionCommand, PredictionState, PredictionStats, predictable_width_one,
};
pub use receive::{DisplayGrid, Output, Resync, Stats, Viewer};

/// RFC 1982 order over Merkur's nonzero display serials (generations,
/// sequences): zero is the no-baseline sentinel, so every serial succeeds it
/// and it succeeds none. The port of `displaySerialIsNewer`.
pub fn display_serial_is_newer(candidate: u32, current: u32) -> bool {
    if candidate == 0 {
        return false;
    }
    if current == 0 {
        return true;
    }
    let distance = candidate.wrapping_sub(current);
    distance != 0 && distance < 0x8000_0000
}

/// Whether `current` is `target` or succeeds it; zero reaches nothing.
pub(crate) fn display_serial_reached(current: u32, target: u32) -> bool {
    current != 0 && (current == target || display_serial_is_newer(current, target))
}
