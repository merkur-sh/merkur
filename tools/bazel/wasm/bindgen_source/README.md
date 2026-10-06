# Original wasm-bindgen CLI producer

The producer uses the published `wasm-bindgen-cli` 0.2.127 crate, its original
Cargo.lock and all three original binary targets. The native Cargo acquisition
captures the original default `rustls-tls` feature selection without compiling
artifacts. Generated rules compile that exact selected graph with the declared
Rust and native compiler toolchains.

`generate.py` emits maintained compiler units and per-binary selected package
source and notice declarations from the captured context. Original registry
archive checksums and normalized manifest metadata determine license inputs.
`publisher-licenses.json` binds the three omitted publisher license texts to
upstream archives at the commits recorded in each original `.cargo_vcs_info.json`,
including original package and workspace manifest Files.

The maintained `wasm-bindgen-shared` build-script patch replaces ambient Git
discovery with the original publisher revision declared by the pinned crate VCS
metadata. It preserves the upstream nine-character release suffix and schema
hashing. The original archive, VCS member, workspace patch and actual modified
compiler source are declared through the existing package source provider.
JSON generation requires an explicit pinned formatter executable.

`declare_bindgen_compiled_attributions` requires each binary's existing linked
standard-library notice producer. It cannot create a complete generator
attribution from source metadata or a downloaded native executable.

The source CLI does not replace the downloaded toolchain until its original CLI
output parity, compiler-derived source and license closure, and native platform
qualification are complete. The retained context currently covers Darwin ARM64;
uncaptured platforms have no default compiler-unit alias.
