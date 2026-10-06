//! The crate's integration tests, one binary so the crate links and launches once.
//!
//! `tests/allocation.rs` stays its own binary: it installs a counting global
//! allocator, which would wrap every test here.

mod animation;
mod boundary;
mod canonical;
mod geometry;
mod ingestion;
mod placeholders;
mod placements;
mod projection;
mod publication;
mod replies;
mod scene;
mod scene_model;
