---
paths:
  - "apps/daemon/dataplane/**"
  - "packages/merkur-codec/**"
  - "packages/merkur-fec/**"
  - "packages/merkur-graphics/**"
  - "packages/merkur-image-worker/**"
  - "packages/term-wasm/**"
---

# Rust dataplane and hot path

`apps/daemon/dataplane` is performance-sensitive: no needless allocation, no blocking
calls in async tasks, no moving hot-path work into TypeScript. In the hot path
performance outranks elegance and diff size: reuse over allocation, borrowing over
cloning, in-place mutation over rebuilding, batched/zero-copy over per-item. Reach for
`unsafe` only with a measured reason and a safety comment. Use Tokio-aware patterns;
blocking PTY/stdin work is already isolated onto threads.

A constant in this tree is one of three things, and its doc comment says which: a wire
fact (mirrored in `packages/protocol` or the edge, and moved together), a resource bound
(a queue, pool, or cap that makes memory bounded by construction), or a budget derived
from a measured input with a stated floor and ceiling. Session liveness, auth, and resume
timing live in `session/policy.rs`, display throughput policy in `display/policy.rs`; the
browser's counterpart is `packages/config/src/reconnect-policy.ts`. A count or streak with
no derivation comment is a heuristic and needs the signal it stands in for, or removal.

Nothing on a latency path waits on a clock. The modules that carry frames and keystrokes
deny the timer calls `clippy.toml` lists (`sleep`, `timeout`, `interval` and their
relatives, in Tokio and in `std`) at the head of their own files, and `rust:lint` fails a
new one: `display/`, `pty/` and `input.rs` here, the `viewer` and `input_*` modules of
`merkur-client`, `merkur-codec`, `merkur-fec`, and the edge's `splice.rs`. A wait there is
for the event itself. A call that has to stay carries an `#[expect]` whose reason names
the signal the platform does not give; tests are exempt. The owner loop in `lib.rs` holds
the daemon's deadlines and is outside the rule.

Crates are on edition 2024, toolchain pinned by `rust-toolchain.toml`; new crates start on
2024. Vendored `[patch.crates-io]` crates keep whatever upstream ships (see
`vendored-crates.md`). Generated artifacts must be rebuilt before they are tested or run:
WASM is hash-pinned and `check:protocol` rejects stale provenance, and the dev CLI executes
the built dataplane binary, where staleness surfaces as unknown IPC frames or auth
timeouts. `build:dataplane` is not a gate; run it only when something will execute the
binary. Gate: `rust:lint`, then one filtered `cargo test -p merkur-dataplane`. Read
the recorded outcomes for the area before proposing a performance change, so an
experiment is not re-run; an outcome is never written into this tree.
