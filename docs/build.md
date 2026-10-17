# Build and test

Bazel is Merkur's one build and test system. `bazel test //...` is every Rust, WebAssembly and
Bun test and every static gate; CI runs it on Linux and macOS, and a workstation runs the same
targets. Cargo's manifests and lockfile stay the source of the Rust dependency graph, which
`crate_universe` reads, and `pnpm-lock.yaml` is the JavaScript one, which `rules_js` reads.

## Running it

| Command | What it does |
| --- | --- |
| `bazel test //...` | Every test and static gate. Bazel runs the ones whose inputs changed and answers the rest from its cache. |
| `bazel test //apps/web:test` | One package's Bun tests. Every package with tests has a `test` target; the Rust crates add `unit`, integration and `doc` targets. |
| `bazel test //apps/daemon/dataplane:unit --test_arg=<filter>` | One filtered libtest run. |
| `bazel test //:static_gates` | The nine static gates, each also a `package.json` script (`bun run check:types`). |
| `bun run rust:lint` | Clippy as a Bazel aspect over every first-party Rust target, held to its baseline. It reads the build's diagnostics rather than being a test, so CI runs it beside `bazel test //...`. |
| `bun run gates` | What the working tree's changes earn: `bazel test //...` plus the gates and suites outside Bazel (`scripts/gate-policy.ts`). |
| `bun run build:wasm` | `bazel run //tools/bazel/wasm:sync`: the WebAssembly packages into the `pkg/` directories Vite and Bun import. |
| `bun run build:native` | `bazel run --config=release //tools/bazel/native:sync`: the dataplane, image worker and terminal client into apps/daemon/dist, the edge and the harnesses' network peers into apps/edge/dist. |

`bazel` is Bazelisk at `.bazelversion`. Tests use `fastbuild`, which `.bazelrc` and
`MODULE.bazel` make Cargo's test profile; `--config=release` is Cargo's release profile, which
the native sync, the harnesses and shipped binaries use.

## The cache

BuildBuddy's remote cache holds what CI built. A workstation reads it and uploads nothing:
`.bazelrc.local` (ignored) enables it with `common --config=remote-cache` and the
`--remote_header=x-buildbuddy-api-key=...` line, the key coming from the Keychain. CI writes
the same file from the `BUILDBUDDY_API_KEY` secret with `--config=ci`, the only writer. A fork's
pull request has no key and builds everything itself.

## Toolchains

Every toolchain is prebuilt and pinned by digest, with one source of truth each, which
`scripts/toolchain-pins.test.ts` holds Bazel to:

| Tool | Pinned by |
| --- | --- |
| Rust | `rust-toolchain.toml`, through `rules_rust` |
| Bun | `.bun-version` (`tools/bazel/bun/extensions.bzl`) |
| Node | `.node-version`, through `rules_nodejs` |
| pnpm | `packageManager` in `package.json` |
| C and C++ | `toolchains_llvm`, with a Linux sysroot |
| wasm-bindgen, binaryen | the `wasm-bindgen` crate `Cargo.lock` pins (`tools/bazel/wasm/extensions.bzl`) |
| Chromium | the revision `playwright-core` names (`tools/bazel/playwright/extensions.bzl`) |
| Redis, OpenSSL | the Bazel Central Registry, Redis with TLS (`tools/bazel/redis/redis-tls.patch`) |

The macOS Secure Enclave bridge compiles with the selected Xcode's Swift.

## How a Bun test runs

`bun_tests` (`tools/bazel/bun/bun.bzl`) runs `bun test` over a package's test files, sharded
where a package is large. It copies its declared files into a checkout of its own in the
test's scratch directory: `//:sources`, which gathers every package's `package_files()`, the
WebAssembly packages, and the installed dependencies, which stay links into `rules_js`'s store
with the `.bin` commands pnpm would write. A walk sees a working tree, and a test reads only
what it declared. Bun, Node, Redis, OpenSSL and Chromium are hermetic and on the test's `PATH`,
as is each native helper a test spawns. A static gate is a `repo_check`: the gate's
`package.json` script over the same checkout, made a Git repository so the gate sees what Git
ignores.

## Adding code

- A Rust crate gets a hand-written `BUILD.bazel`: `rust_library`, its `rust_test` and
  `rust_doc_test` targets, `extract_cargo_lints` for its `[lints]`, and `package_files()`.
  `all_crate_deps()` names its dependencies from `Cargo.toml`.
- A workspace package with tests gets `bun_tests` over its `*.test.ts` files.
- Every `BUILD.bazel` calls `package_files()`. `bun run scripts/bazel-sources.ts` rewrites the
  package list `//:sources` gathers (`tools/bazel/sources.bzl`); `check:bazel-sources` fails
  when it is stale.
- A WebAssembly package's crate graph is its own Cargo workspace under
  `tools/bazel/wasm/<package>`, which `bun run build:wasm-workspaces` regenerates after a
  manifest or `Cargo.lock` change.
- The network simulator's crate graph is its own workspace under `tools/bazel/sim`, the
  production crates it reaches as members, which `bun run build:sim-workspace` regenerates
  and `bun run test:sim:update-lock` re-locks; its libraries build only in the configuration
  its tests set, with `--cfg merkur_sim`. The ownership proofs and the edge's kernel profiler
  are workspaces of their own with crate hubs of their own.

## Release builds

`//tools/bazel/release` builds what a release ships, in Cargo's release profile whatever the
command line's configuration. The release identity arrives as settings
(`--//tools/bazel/release:version=...`, `sequence`, `release_public_key`, `public_origin`,
`opaque_pin`, `commit`), which a development build leaves at their defaults.

| Target | What it is |
| --- | --- |
| `:daemon` | This platform's `merkur-daemon-<platform>.tar.gz`: the compiled CLI, the profile-guided dataplane, the image worker and the terminal client. `--config=macos_x86_64` builds `darwin-x64` on Apple Silicon. |
| `:dataplane_profile` | The dataplane's merged LLVM profile, trained on its suite and benchmarks. |
| `:verify` | The release verifier the signing and deployment jobs run. |
| `:deployment` | The unsigned server deployment, on Linux x64: `server/server`, `migrations/`, the precompressed `web/`. |
| `:site` | The website's `site-server` and `dist/`, on Linux x64. |
| `:image_binaries` | `bazel run` installs the edge and STUN release binaries into `dist/images`, which their Dockerfiles copy in. |

## Baselines

The ratchets hold the tree to committed baselines and never raise them: fix the code. A
baseline entry the tree no longer needs fails as loose until it is lowered.

| Gate | Baseline | Lowered by |
| --- | --- | --- |
| `check:ratchet` | `fallow-baselines/` (dead code, exact clones, complexity ceilings) | `bun run check:ratchet --tighten` |
| `check:slop` | `lint-baselines/anti-slop.json` | `bun run check:slop --tighten` |
| `rust:lint` | `lint-baselines/clippy.json` | `bun run rust:lint --tighten` |

The pre-commit hook runs the ratchet and the anti-slop gate over the staged files.
