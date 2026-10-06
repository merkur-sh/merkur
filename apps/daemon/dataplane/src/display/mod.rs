// A latency path: the display waits on the event itself, never on a clock. `clippy.toml`
// lists the timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

pub(crate) mod clock;
pub mod compressor;
pub(crate) mod credit;
#[cfg(test)]
mod credit_loop;
#[cfg(test)]
pub(crate) mod cursor_lab;
pub mod encoder;
pub(crate) mod fec;
#[cfg(test)]
mod graphics_convergence;
pub(crate) mod planner;
pub mod policy;
pub(crate) mod recv;
pub(crate) mod send;
pub(crate) mod wire;
#[cfg(test)]
pub(crate) mod sim;
#[cfg(test)]
pub(crate) mod viewer;
