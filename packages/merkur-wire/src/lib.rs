//! The terminal wire between a client and the dataplane.
//!
//! Channel ids, edge lanes, protocol frames and control messages live in
//! [`protocol`]; input records in [`input_record`]; the signaling messages in
//! [`signaling`]. The edge's own contract is `merkur-edge-protocol`. The
//! TypeScript mirrors are `packages/protocol` and
//! `packages/shared/src/transport.ts` until the browser moves onto the Rust
//! client core.

// Everything here parses bytes a peer sent, the signaling lane before any
// authentication, so a panic is a remote denial of service: nothing in this
// crate may panic. `clippy.toml` switches the first four lints off inside
// tests; the other four hold in tests too, and a test that needs one carries
// an `#[expect]` with its reason.
#![deny(
    clippy::indexing_slicing,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreachable,
    clippy::string_slice,
    clippy::unwrap_in_result,
    clippy::get_unwrap
)]

pub mod input_record;
pub mod protocol;
pub mod signaling;

pub mod terminal_ui;
