//! Bounded authenticated discovery wire format shared by the daemon and observers.

// Every byte this crate reads comes off an unauthenticated UDP socket, so a
// panic here is a remote denial of service: nothing in it may panic.
// `clippy.toml` switches the first four lints off inside tests; the other four
// hold in tests too, and a test that needs one carries an `#[expect]` with its
// reason.
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

pub mod message;
