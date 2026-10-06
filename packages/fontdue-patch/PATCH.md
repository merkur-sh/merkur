# Merkur font loading patch

Vendored from fontdue 0.9.4 (MIT OR Apache-2.0 OR Zlib; upstream licenses retained).

`src/font.rs` retains validated font bytes in an Arc and stores glyph outlines in
`once_cell::race::OnceBox` slots. Loading collects the same character/substitution
indices and metrics; measuring or rasterizing a glyph compiles its original
geometry once. Metrics, grayscale/subpixel rasterization and cache invalidation
are unchanged. Unused glyphs allocate no outline geometry. Concurrent first use
publishes one retained outline; cloned fonts retain immutable source ownership.

The eager parallel-loading feature is removed with the eager implementation.
`src/lib.rs` suppresses a newer compiler's unnecessary-transmute warning in the
unchanged upstream SIMD code. `src/lazy_tests.rs` pins upstream metrics and raster
hashes for all five bundled Merkur fonts at three sizes and checks lazy cache
and concurrent ownership. Run `cargo test -p fontdue --lib` from the repo root.

This directory is a Cargo patch, not a workspace member. Terminal WASM provenance
includes it through the existing dependency-closure hash.
