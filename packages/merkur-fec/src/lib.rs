//! Hand-rolled systematic Cauchy Reed-Solomon over GF(2^8).
//!
//! Sized for tiny batches (≤ 4 data shards, ≤ 2 recovery shards) where
//! generic libraries pay a large fixed FFT overhead. No allocations, no
//! dependencies, `no_std`. One fused SIMD pass per encode or decode: NEON on
//! AArch64, SSSE3 on x86_64, `simd128` on WASM.

#![no_std]
// A latency path: the code runs for every protected display batch and waits on nothing.
// `clippy.toml` lists the timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

#[cfg(test)]
extern crate alloc;

mod codec;
mod field;
pub mod repair;
mod simd;

pub use codec::{
    EncodeError, FEC_MAX_DATA, FEC_MAX_RECOVERY, FEC_MAX_SHARD_BYTES, PARITY, decode, encode,
};
