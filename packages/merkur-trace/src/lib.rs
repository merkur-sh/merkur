//! Bounded native trace recorder shared by Merkur's Rust crates.
//!
//! Two record classes share one owner (an observation of one session):
//!
//! - **Spans** (`span!`) mark where time goes. A disabled span is one relaxed load and a
//!   branch; an enabled one is two counter reads and two stores into the calling thread's
//!   own ring. They carry no ordinal and order by their timestamps.
//! - **Evidence** (`record`) is the closed diagnostic vocabulary the e2e oracles join on.
//!   Each record takes a process-wide ordinal, the happens-before fence those joins need
//!   across threads, and stamps the `Instant` its caller already read.
//!
//! Producers never serialize, perform IO, allocate, or take the metadata lock. A thread
//! claims a ring from a fixed pool on its first record and releases it when it exits; a
//! full ring or an exhausted pool refuses the record and counts it. Capture is cold work
//! that drains every ring under the metadata lock and writes one file (`file.rs`).
//!
//! On `wasm32` (term-wasm, merkur-client) only `Site`, `span!` and `span` exist, and a span
//! is `None`: the browser has its own perf ring.

#[cfg(not(target_arch = "wasm32"))]
mod clock;
#[cfg(not(target_arch = "wasm32"))]
mod file;
#[cfg(not(target_arch = "wasm32"))]
mod recorder;

#[cfg(not(target_arch = "wasm32"))]
pub use recorder::{
    Evidence, MAX_SITES, Owner, Snapshot, SpanEvent, SpanGuard, Token, active_token, begin,
    capture, claim_thread, elapsed_us, end, mark, record, span, span_arg,
};

/// A named trace point: a span name or an evidence kind. Ids are assigned on first use, so
/// a site costs nothing until a capture reaches it.
pub struct Site {
    name: &'static str,
    #[cfg(not(target_arch = "wasm32"))]
    id: std::sync::atomic::AtomicU32,
}

impl Site {
    pub const fn new(name: &'static str) -> Self {
        Self {
            name,
            #[cfg(not(target_arch = "wasm32"))]
            id: std::sync::atomic::AtomicU32::new(0),
        }
    }

    pub fn name(&self) -> &'static str {
        self.name
    }
}

/// Opens a span named `$name` until the returned guard drops: `let _span = span!("x");`.
/// With a second argument the span carries one value, such as a byte count.
#[macro_export]
macro_rules! span {
    ($name:literal) => {{
        static SITE: $crate::Site = $crate::Site::new($name);
        $crate::span(&SITE)
    }};
    ($name:literal, $arg:expr) => {{
        static SITE: $crate::Site = $crate::Site::new($name);
        $crate::span_arg(&SITE, $arg)
    }};
}

#[cfg(target_arch = "wasm32")]
pub struct SpanGuard;

#[cfg(target_arch = "wasm32")]
#[inline(always)]
pub fn span(_site: &'static Site) -> Option<SpanGuard> {
    None
}

#[cfg(target_arch = "wasm32")]
#[inline(always)]
pub fn span_arg(_site: &'static Site, _arg: u64) -> Option<SpanGuard> {
    None
}
