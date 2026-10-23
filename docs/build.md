# Build and test

Bazel is Merkur's one build and test system. `bazel test //...` is every Rust, WebAssembly and
Bun test and every static gate; CI runs it on Linux and macOS, and a workstation runs the same
targets. Cargo's manifests and lockfile stay the source of the Rust dependency graph, which
`crate_universe` reads, and `pnpm-lock.yaml` is the JavaScript one, which `rules_js` reads.

## Running it

| Command | What it does |
| --- | --- |
| `bazel test //...` | Every test and static gate. Bazel runs the ones whose inputs changed and answers the rest from its cache. |
| `bun run test:quick` | The edit loop, `bazel test --config=quick //...`: every test but the nineteen tagged `repository`, which read the whole repository and so rerun after any edit (the whole-tree gates, the gates' own tests, the scans), and without building their checkout. Run `bazel test //...` before a push. |
| `bazel test //apps/web:test` | One package's Bun tests: a suite of one test per test file (`//apps/web:src/api.refresh.test` for `src/api.refresh.test.ts`). The Rust crates add `unit`, integration and `doc` targets. |
| `bazel test //apps/daemon/dataplane:unit --test_arg=<filter>` | One filtered libtest run. |
| `bazel test //:static_gates` | The static gates, each also a `package.json` script (`bun run check:types`). `check:types` is one test per TypeScript project, over the files its `tsc` lists; `check:lint` and `check:slop` one per Bazel package, over its own files. |
| `bazel test //:rust_lint` | `rust:lint`: Clippy as a Bazel aspect over every first-party Rust target, cached per crate and held to its baseline; part of `bazel test //...`. |
| `bun run gates` | What the working tree's changes earn: `bazel test //...` plus the gates and suites outside Bazel (`scripts/gate-policy.ts`). |
| `bun run profile:query bazel <query>` | SQL over the last command's own profile (`command.profile.gz`): `bazel-phases`, `bazel-critical-path`, `bazel-slow-actions`, `bazel-waits`, `bazel-categories` (`packages/profile/queries/`). |
| `bun run build:wasm` | `bazel run //tools/bazel/wasm:sync`: the WebAssembly packages into the `pkg/` directories Vite and Bun import. |
| `bun run build:native` | `bazel run //tools/bazel/native:sync`: in Cargo's release profile, whatever the command line's configuration, the dataplane, image worker and terminal client into apps/daemon/dist, the edge and the harnesses' network peers into apps/edge/dist. |

`bazel` is Bazelisk at `.bazelversion`. Tests use `fastbuild`, which `.bazelrc` and
`MODULE.bazel` make Cargo's test profile; `--config=release` is Cargo's release profile. The
native sync, the benchmarks (`//apps/daemon/dataplane:unit_release`) and shipped binaries are
`release_binary` targets (`tools/bazel/release/defs.bzl`), which build in the release profile
from any command line, so a workstation alternating `bazel test` and `bun run build:native` keeps
one analysis cache; a different `--config` on the command line would discard it.

## The cache

Every checkout and worktree on a machine shares one disk cache, `~/.cache/merkur-bazel/disk`,
which Bazel collects past 30 GB or 14 days of disuse; a new worktree starts from what the others
built. A CI runner keeps none.

BuildBuddy's remote cache holds what CI built. A workstation reads it and uploads nothing:
`.bazelrc.local` (ignored) enables it with `common --config=remote-cache` and the
`--remote_header=x-buildbuddy-api-key=...` line, the key coming from the Keychain. CI writes
the same file from the `BUILDBUDDY_API_KEY` secret with `--config=ci`, the only writer. A fork's
pull request has no key and builds everything itself. On CI, repository downloads also go through
BuildBuddy (`--experimental_remote_downloader`), keyed by checksum, so a runner fetches only the
archives its build needs and restores no repository cache; `--jobs=32` keeps remote lookups in
flight beside the local work the runner's CPUs bound.

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

`//tools/bazel/native:natlab_runtime` copies the pinned target-platform Bun and Node executables
into declared build outputs. The NAT lab stages these files with its Linux native programs into
a disposable source snapshot; building a Linux lab on macOS does not replace the checkout's host
executables.

The sync targets accept `--output-root DIRECTORY` to install their declared destinations into
a disposable checkout. The NAT lab uses the WASM sync target this way, including both terminal
WASM import locations, before starting its packaged web server.

## How a Bun test runs

`bun_test_files` (`tools/bazel/bun/bun.bzl`) makes one test per test file: `bun test` over that
file in a checkout of its own in the test's scratch directory, holding exactly what the file
loads, so a test reruns only when one of those files changes. `scripts/bazel-modules.ts`
generates what each file loads (`tools/bazel/modules.bzl`) as a `<path>.module` target in the
package that owns it:

- what it imports, as Bun resolves it;
- what it names relative to itself with a literal `new URL('…', import.meta.url)` or
  `import.meta.resolve('…')`: a directory so named is every file in it, and the repository's root
  the whole checkout;
- its nearest `package.json` and `tsconfig.json`, with what that extends.

Every test also holds `bunfig.toml` and its preloads, and the installed third-party packages,
which stay links into `rules_js`'s store with the `.bin` commands pnpm would write. A workspace
package a package depends on links to the checkout's own directory (`WORKSPACE_DEPENDENCIES` and
`WORKSPACE_LINKS` in `tools/bazel/sources.bzl`), so its relative paths, such as a `tsconfig.json`
extending the root's, resolve as in a working tree.

What a test reads by any other name it declares in `bun_test_files`'s `files`: `data` (another
file's module target, such as a script it runs or a fixture it reads by a computed path),
`tools` (a native helper it spawns, put on its `PATH`), `browsers` (Playwright's Chromium), or
`checkout` (the whole repository, for a gate's test or a scan). An undeclared read fails, because
the checkout does not hold the file. Bun, Node, Redis, OpenSSL and Chromium are hermetic.

A static gate is a `repo_check`: the gate's `package.json` script over a checkout of the whole
repository, made a Git repository so the gate sees what Git ignores. That checkout is built once,
`//:checkout` (`repo_snapshot`, `tools/bazel/bun/snapshot.ts`): every package's files, the
WebAssembly packages, the vendored crates and the tracked symlinks, committed. Each gate, and each
test that declares `checkout`, clones it (copy-on-write on macOS) rather than copying and
committing the repository itself; it stays out of the remote and disk caches. The globs that
gather a package's files leave out what `.gitignore` does (`IGNORED` and `ROOT_IGNORED` in
`tools/bazel/files.bzl`, the local-state directories in `REPO.bazel`), so a local tool's cache or
key never becomes a test's input. `check:types` is one test
per TypeScript project (`type_checks`): `scripts/check-types.ts --project <tsconfig>` over the
files `tsc --listFilesOnly` lists for that project, each one's nearest `package.json`, and the
project's configuration chain (`TYPE_PROJECTS` in `tools/bazel/modules.bzl`). `check:slop` is one
test per Bazel package (`slop_checks`): `scripts/check-slop.ts --package <directory>` over the
package's own files, the rules and the baseline, judging only the entries that package owns; its
rules read one file at a time. `check:lint` is likewise one test per Bazel package
(`lint_checks`): `biome check .` over the package's own files, `biome.json` and `.gitignore`,
since no rule `biome.json` enables reads another file. A gate that reads named parts of the
repository is a `scoped_check` over those parts: `rust:lint` over Clippy's diagnostics, its
baseline and the Rust sources, `check:latency-boundaries` over the web app,
`check:span-lifetimes` and `check:span-attributes` over the services, the edge and the packages.

## Adding code

- A Rust crate gets a hand-written `BUILD.bazel`: `rust_library`, its `rust_test` and
  `rust_doc_test` targets, `extract_cargo_lints` for its `[lints]`, and `package_files()`.
  `all_crate_deps()` names its dependencies from `Cargo.toml`.
- A package with tests gets `bun_test_files` over its `*.test.ts` files.
- Every `BUILD.bazel` calls `package_files()`, which also declares the package's module targets.
  `bun run scripts/bazel-sources.ts` rewrites the package list `//:sources` gathers
  (`tools/bazel/sources.bzl`) and the module graph (`tools/bazel/modules.bzl`), after an import,
  a test file, a workspace dependency or a `BUILD.bazel` changes; `check:bazel-sources` fails
  when either is stale.
- A WebAssembly package's crate graph is its own Cargo workspace under
  `tools/bazel/wasm/<package>`, which `bun run build:wasm-workspaces` regenerates after a
  manifest or `Cargo.lock` change.
- The network simulator's crate graph is its own workspace under `tools/bazel/sim`, the
  production crates it reaches as members, which `bun run build:sim-workspace` regenerates
  and `bun run test:sim:update-lock` re-locks; its libraries build only in the configuration
  its tests set, with `--cfg merkur_sim`. The ownership proofs and the edge's kernel profiler
  are workspaces of their own with crate hubs of their own.
- Local crate mirrors watch the canonical source tree, including nested additions and deletions.
  A simulator workspace symlink therefore consumes the same current transport source as the
  checkout's other builds.
- The vendored transport crates (`Cargo.toml`'s `exclude`) test from a workspace of their own
  under `tools/bazel/vendored`, each a member with its dev-dependencies, which
  `bun run build:vendored-workspace` regenerates and `--update-lock` re-locks from the release
  lock; it fails when a crate the release links would move version.

## Release builds

`//tools/bazel/release` builds what a release ships, in Cargo's release profile whatever the
command line's configuration. The release identity arrives as settings
(`--//tools/bazel/release:version=...`, `sequence`, `release_public_key`, `public_origin`,
`opaque_pin`, `commit`), which a development build leaves at their defaults. Its targets are
`manual`: `bazel test //...` skips them, and the release jobs build them by name.

| Target | What it is |
| --- | --- |
| `:daemon` | This platform's `merkur-daemon-<platform>.tar.gz`: the compiled CLI, the profile-guided dataplane, the image worker and the terminal client. `--config=macos_x86_64` builds `darwin-x64` on Apple Silicon. |
| `:dataplane_profile` | The dataplane's merged LLVM profile, trained on its suite and benchmarks. |
| `:verify` | The release verifier the signing and deployment jobs run. |
| `:deployment` | The unsigned server deployment, on Linux x64: `server/server`, `migrations/`, the precompressed `web/`. |
| `:site` | The website's `site-server` and `dist/`, on Linux x64. |
| `:service_binaries` | `bazel run` installs the edge and STUN release binaries into `dist/services`, which the release ships to the service hosts. |

## Baselines

The ratchets hold the tree to committed baselines and never raise them: fix the code. A
baseline entry the tree no longer needs fails as loose until it is lowered.

| Gate | Baseline | Lowered by |
| --- | --- | --- |
| `check:ratchet` | `fallow-baselines/` (dead code, exact clones, complexity ceilings) | `bun run check:ratchet --tighten` |
| `check:slop` | `lint-baselines/anti-slop.json` | `bun run check:slop --tighten` |
| `rust:lint` | `lint-baselines/clippy.json` | `bazel run //:rust_lint -- --tighten` |

The pre-commit hook runs the ratchet and the anti-slop gate over the staged files.
