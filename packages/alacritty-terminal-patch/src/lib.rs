//! Alacritty - The GPU Enhanced Terminal.

#![warn(rust_2018_idioms, future_incompatible)]
#![deny(clippy::all, clippy::if_not_else, clippy::enum_glob_use)]
#![cfg_attr(clippy, deny(warnings))]
// Vendored upstream code. Upstream's own `deny(clippy::all)` above trips on
// lints added after this snapshot was taken, which would fail `bun run
// rust:all` for code Merkur does not own. Relax only the lints newer clippy
// raises here; Merkur's own crates stay under `-D warnings`.
#![allow(clippy::question_mark)]

pub mod event;
#[cfg(not(target_arch = "wasm32"))]
pub mod event_loop;
pub mod grid;
pub mod index;
pub mod selection;
pub mod sync;
pub mod term;
pub mod thread;
#[cfg(not(target_arch = "wasm32"))]
pub mod tty;
pub mod vi_mode;

pub use crate::grid::Grid;
pub use crate::term::Term;
pub use vte;
