//! The native driver of the Merkur client core: the account API over HTTPS,
//! edge attachments over WebTransport, a tokio loop that runs a
//! [`merkur_client::session::Session`] between them, and the terminal grid
//! its viewer applies display frames to.

pub mod account;
pub mod carrier;
mod credit;
pub mod driver;
pub mod grid;
pub mod issuer;
pub mod opaque;
mod path_hints;
#[cfg(merkur_sim)]
pub use path_hints::sim::network_changed;
