//! Bounded graphics command ingestion and publication ownership.
//!
//! This crate has no filesystem, network, or cryptographic authority. Its tile
//! verifier accepts only the bounded immutable representation used by asset owners.
//! APC framing belongs to VTE. Image validation belongs to the isolated helper;
//! successful syntax parsing is never evidence of a valid or available image.

#![forbid(unsafe_code)]

pub mod animation;
pub mod boundary;
pub mod budget;
pub mod command;
mod diacritics;
pub mod geometry;
pub mod ingest;
pub mod placeholder;
pub mod placements;
pub mod processing;
pub mod projection;
pub mod publication;
pub mod reply;
pub mod scene;
pub mod source;
pub mod tile;
