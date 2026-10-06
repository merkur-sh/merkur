---
name: verify
description: Select and batch Merkur's verification gates for a change - which bun test, cargo test -p, check:*, test:e2e:*, or test:natlab command a change under apps/*, packages/*, protocol, IPC, Rust, or WASM implicates, how to batch them, their warm cost, and what the cheap gates cannot prove. Use before running tests, when asked what to run, to verify, run the gates, or before reporting a change done.
---

# Verifying a change

Verification is **batched and selected**, and re-running it is cheap by construction: the
bun lane skips every test file already green for the exact bytes it reads, so
`bun run gates --run` twice with no edit between costs seconds the second time. Run it when
you want an answer. What you should not do is guess at the answer — "I think that passed"
after a compaction is a re-run, and a re-run is what the cache is for.

Start with `bun run gates`: it reads the working tree (or `--base <ref>`, or
`--files a,b`), matches every changed path against `RULES` in `scripts/gate-policy.ts`,
and prints the batched commands with the selection reason for each path. `--run` executes
them (artifact builds and shared preflight first, static gates concurrently, then the cargo
lane in parallel with the bun lane);
`--all` also runs the deferred minutes-long suites after the preceding checks pass. Rows
printed "by hand" are the browser and Docker harnesses and the long graphics convergence
runs: `--run` alone leaves them pending; `--run --all` executes them. The rules are
rendered as a table below; edit the rules, never the table.

Each run saves logs and a JSON report under `test-results/verification`. Deferred required
checks remain pending there until executed, so cheap-check success is not full verification.

Protocol plans always prepare the authenticated session oracle because protocol expansion adds
its fixture tests after owning-suite selection. Selected tests whose compiler-parsed import closure includes
`scripts/perf/client-session-fixture.ts` run
`bun run scripts/prepare-client-session-oracle.ts` once in preflight. It builds the signed
native session oracle only when its source-and-binary SHA-256 manifest is absent or stale,
then validates the receipt before the Rust and Bun lanes start in parallel. The manifest
includes exact Rust crate inputs (including untracked inputs), workspace and Cargo
configuration, the pinned toolchain, the Cargo command and the executable hash. The manifest
names one independent, content-addressed executable copy with mode 0555, so parallel Cargo
profile builds cannot replace it. Benchmarks
and fixture tests only verify and consume that artifact; they never invoke Cargo. Direct
session benchmark runs need the same explicit preparation command before execution. Complete
`test:unit` and `verify` plans also include this shared preflight.

## The result cache

`test-results/verification/cache.json` records which test files are green and for which
inputs, so a plan only runs what it cannot already prove. It is per-checkout and gitignored.

A test's key is the sha256 of its compiler-parsed import closure — every file
`testDependents` reaches from it, assets included — plus `package.json`, `bun.lock`,
`bunfig.toml`, `tsconfig.base.json`, `scripts/test-preload.ts`, the executor and JUnit reader,
the Bun version, the platform and the arch. Edit one module and only its dependents lose their key; edit the
lockfile and every test does. A printed plan (`bun run gates`, no `--run`) names the split,
which is how you answer "is this diff verified?" without running anything.

**Only the bun lane is cached.** The nine static gates always run: they cost about seven
seconds together and they are the floor this rests on. Cargo always runs. Selected test
targets compile together once, then the executor runs the emitted binaries with each
package’s filters; Cargo still runs doctests for the same package union. The browser and
Docker harnesses always run, because they depend on a live daemon, edge and container
that no content key can see.

Two limits worth knowing:

- **Results are attributed per file.** A complete, validated Bun JUnit report records green
  files even when another file fails. Assertions, teardown errors and worker crashes stay red.
  Missing, truncated or inconsistent reports prove nothing; an interrupted run records nothing.
  Starting a run revokes prior results for the attempted files, including forced runs.
- **Only imports are visible.** A test that opens a fixture with `readFileSync` has an input
  the closure cannot see. The selector covers this from the other side: a changed file the
  bun lane owns that appears in no closure discards every cached result for that run. Nothing
  guesses which test reads it.

`bun run gates --force`, or `MERKUR_GATE_CACHE=0` for the other entry points, ignores the
cache entirely.

## Always: run the static gates

`bun run check:secrets` is a separate, networked scan of staged file contents using the
pinned TruffleHog binary installed by `bun run setup:hooks` (also part of `bun run setup`).
The pre-commit hook runs it automatically; CI independently scans pushed/PR commit ranges.
It is not one of the nine static gates, and an empty index is not a repository audit.
See `docs/security.md` for the failure policy and full-history audit command.

Native tsc, Biome over the whole repo, five single-process source scans, the fallow
ratchet (about a second, its three analyses concurrent), and the anti-slop baseline (Biome
again, with the rule plugins, over the files whose bytes it has not seen). Never select among
them, never skip them:

```
bun run check:types && bun run check:lint && bun run check:latency-boundaries && bun run check:span-lifetimes && bun run check:span-attributes && bun run check:dead && bun run check:ratchet && bun run check:slop && bun run check:docs
```

`check:ratchet` fails what the uncommitted diff introduces (dead code, exact clones and
functions over the complexity thresholds, from `fallow audit`) and any growth in an
existing hotspot of a file it touches (`fallow-baselines/complexity-ceilings.json`). A
hotspot that shrank fails too until `bun run check:ratchet --tighten` lowers its ceiling.
Renamed-identifier clones print as notes and never fail. The pre-commit hook runs it with
`--staged`, which refuses a staged non-prose file that also has unstaged edits.

`check:slop` runs the anti-slop rules over the tree and compares the findings, per file and
per rule, with `lint-baselines/anti-slop.json`. There are two sets. The Biome rules are
GritQL plugins, one file each under `tools/biome/slop/`, listed by `biome.slop.json`, over
script files; `check:lint` does not load them. The comment rules
(`scripts/comment-rules.ts`, named `comment-…`) read the comments of script files and of
first-party Rust: the phrases that put off or doubt what the code does ("for now",
"temporary", "should work", "hopefully"), and `TODO` or `FIXME` in a comment that holds no
URL. A file or rule the baseline does not name is allowed nothing, so new code meets every
rule; a count above its entry fails and prints each finding with the rule's message, which
is the repair instruction. The baseline is never raised: fix the code. A count below its
entry, or an entry for a deleted file, fails too until `bun run check:slop --tighten` lowers
it, and `--tighten` refuses to raise or add an entry. A `biome-ignore` comment that names
`lint` as a whole or `lint/plugin` fails as well: no rule is suppressed, while a suppression
of one built-in rule (`lint/suspicious/noConsole`) is not the gate's business. The pre-commit
hook runs it with `--staged`, over the files in the index only.

A Biome rule sees one file at a time, so the gate keeps each file's Biome findings under the
file's bytes and the rule set (`test-results/verification/slop-cache.json`;
`MERKUR_GATE_CACHE=0` ignores it). The comment rules read every file on every run, a fraction
of a second. A run lints only what changed and costs under a second; the first run in a
checkout, and the first after a rule, `biome.slop.json`, `scripts/check-slop.ts` or the Biome
version changes, lints every file, about 115 CPU-seconds (16 s on 14 idle cores).

A Biome rule is GritQL, which matches syntax in one file: no scope analysis, no generic alias
instantiation, no recursion (every "all the way down" is a fixed depth). Each rule's file
opens with what it reports and what it cannot see. `tools/biome/slop/cases.json` holds, per
rule, the code it must report and the code it must leave alone, and the cases a rule does
not reach carry what was intended and the limit that stops it; `scripts/check-slop.test.ts`
runs every case through the same Biome invocation as the gate. Change a rule and its cases
together. A rule file that does not compile fails the gate as unverified, never as a pass.

Changes confined to prose (`*.md`, `docs/**`) need only `check:docs`. A file no
row matches (a `fly.toml`, a Dockerfile) still earns the static gates. `build:dataplane` is
not a gate: run it only when something will *execute* the binary (dev CLI, edge harness),
never to satisfy `cargo test`, which builds its own.

## Batch what you selected

Process spawns and Cargo freshness checks dominate small runs.

- **One exact inventory with isolated workers**: use the planner's `bun test --parallel=N` (up to eight available CPUs)
  command. Bun gives each file a fresh global/module registry inside a worker process,
  including module-mocking tests. Do not reintroduce directory filters: they can match
  generated copies elsewhere in the tree. The executor adds `--timings`: per-file durations
  from earlier runs (`test-results/verification/test-timings.json`, each run's update
  published by rename) make Bun start the slowest files first. They change only the order.
- **One Cargo build, package-specific execution**: the executor builds all selected packages
  with `cargo test --no-run --message-format=json`, reads the emitted executable paths and
  runs each package’s binaries with its own filters and working directory, four binaries at
  a time; a failing binary's output is printed whole when it finishes. Library doctests
  stay under Cargo with the same package union. For a manual single-crate run, libtest takes
  several filters after `--`:
  `cargo test -p merkur-dataplane --locked -- session::rebind_flow::tests network::peer::tests`.
  Multiple crates share an invocation too: `cargo test -p merkur-e2e -p merkur-edge`.
- **Never `rust:check` with `rust:lint`**: Clippy `--all-targets` is a strict superset and
  uses different metadata, so running both compiles the workspace twice.
- **Never `check` plus one of its members**, or `verify` plus `check`.
- **Cargo serializes on the target-dir lock**: never two Cargo commands on `target/rust` at
  once. `rust:lint` keeps its own `target/clippy`, so the cargo lane runs Clippy and
  `rust:deps` beside the test build rather than ahead of it. Cargo and `bun test` overlap too.

The hooks in `.claude/settings.json` / `.codex/hooks.json` refuse the three redundant
combinations and a backgrounded second Cargo on one command line; Cargo's own target-dir
lock serialises everything else.

No test worker spawns synchronously. Bun's synchronous spawn can lose its child's exit
([oven-sh/bun#34069](https://github.com/oven-sh/bun/issues/34069)): the worker spins at 100%
CPU beside a `<defunct>` child, past every test timeout, or the timeout kills the child and
every later synchronous spawn in that worker returns empty. `scripts/test-preload.ts`
therefore replaces `Bun.spawnSync`, which `execFileSync` and `execSync` route through, with a
function that throws; tests and the code they call spawn through `runTestProcess`
(`scripts/test-process.ts`) or an awaited `Bun.spawn`. The same preload makes
`FinalizationRegistry` register nothing (`scripts/test-inert-finalization.ts`): under
`--isolate` a registry outlives its test file, and its cleanup then ran in a global that was
gone, which crashed the worker and aborted the run.

## Commands and their warm cost

Warm on a 14-core machine, measured 2026-08-26. Cold, or after a broad Rust change,
these grow by an order of magnitude, which is the whole reason selection matters.

| Command | Covers | Warm |
| --- | --- | --- |
| `check:types` | native tsc, `--noUnusedLocals --noUnusedParameters` | <1 s |
| `check:lint` | Biome | <1 s |
| `check:latency-boundaries` | hot-path modules importing `effect` | <1 s |
| `check:span-lifetimes` | `Effect.withSpan` composed with a non-returning effect | <1 s |
| `check:span-attributes` | code bypassing the typed span attribute map, and edge field drift | <1 s |
| `check:dead` | `check:files` reachability + `fallow` unused exports/types | <1 s |
| `check:ratchet` | dead code, clones and hotspots the diff introduces; hotspot ceilings; its three fallow analyses run concurrently | ~1 s (2026-10-03) |
| `check:slop` | anti-slop findings per file and rule against `lint-baselines/anti-slop.json`; Biome with the GritQL rule plugins, over the script files whose bytes are new, and the comment rules over script and Rust files | <1 s; ~16 s when every file is linted (2026-10-05) |
| `check:docs` | prose paths, links, pinned facts, config/e2e/workspace parity, harness shape | <1 s || `check:protocol` | wire/IPC/route suites, WASM provenance, Rust suites (needs Cargo) | no wall-clock retention wait |
| `check` | the nine static gates plus `check:protocol` | no wall-clock retention wait |
| `test:unit` | complete source inventory, up to eight isolated workers | ~10 s uncached (2026-10-03) |
| `check:audit` | Bun and Cargo dependency advisories and yanked Rust releases; install cargo-audit with `setup:audit`; needs network, so it sits in `verify` | network |
| `verify` | static gates, protocol prerequisites, merged unit/protocol tests, Cargo lane, audit | see the dated DX audit |
| `rust:lint` | one Clippy pass over every target in `target/clippy`, sorted by `scripts/rust-lint.ts`; a strict superset of `rust:check`. No warning is allowed outside the ratcheted lints, which are held per file and lint to `lint-baselines/clippy.json`. A suppression is `#[expect(lint, reason = "…")]`, and one the lint no longer meets fails | <1 s idle; ~45 s into an empty `target/clippy` (2026-10-05) |
| `rust:deps` | `cargo shear`: unused or misplaced crate dependencies; the cargo lane runs it after `rust:lint`, beside the test build; install it with `setup:shear` | ~1 s |
| `cargo test -p merkur-dataplane <filters>` | one filtered dataplane run | ~2 s |
| `build:image-worker`, then `cargo test --locked -p merkur-dataplane -- --ignored real_helper::` | the sandboxed image helper, then every dataplane test that runs it (26 on 2026-09-19) | ~5 s build, ~7 s run |
| `rust:test` | every workspace crate through the Cargo lane (one build, binaries four at a time, doctests), then release `term-wasm` | ~10 s run after a warm build (2026-09-29) |
| `test:graphics:long` | 64-seed convergence, both drivers, seeds across cores | ~20 s (2026-09-29) |
| `build:dataplane` | release dataplane binary the dev CLI runs | ~8 s |
| `rust:all` | lint, then dataplane + WASM + sync builds; **no** Rust tests | — |
| `build:web` `build:server` `build:daemon` `build:wasm` | artifacts | — |
| `bench:reconnect` | carrier-recovery latency per failure scenario, in process | ~3.5 min |
| `--cwd apps/server telemetry:smoke` | server telemetry wire contract | — |
| `test:dragonfly` | `*.dragonfly.test.ts` against a real container; starts it and injects `DRAGONFLY_TEST_URL` | — |
| `test:e2e:*`, `test:natlab`, `bench:*`, `profile:*` | see below | minutes |

`rust:lint` runs Clippy once (`--workspace --all-targets --cap-lints warn`, JSON out) and
`scripts/rust-lint.ts` sorts every finding into one class. Nothing allows a compiler
warning, a default Clippy lint, a lint of `[workspace.lints]`, an `#[expect]` its lint no
longer meets, a panic lint in `merkur-wire`, `merkur-stun-protocol` and
`merkur-edge-protocol`, tests included, or a timer call in a module on a latency path
(`clippy.toml` lists the calls; each such module denies them at the head of its file, tests
exempt): fix the code, or expect the lint where it fires.
Each is printed as the compiler rendered it. Clippy lints workspace members only, so a
warning in a `[patch]` crate that is not a member is not a finding. The ratcheted lints
are counted per file and lint against `lint-baselines/clippy.json` on the terms of
`check:slop`: a file or lint the baseline does not name is allowed nothing, the baseline is
never raised, and a count that dropped fails until `bun run rust:lint --tighten`. They are
`cast_possible_truncation`, `cast_sign_loss`, `cast_possible_wrap`, `map_err_ignore`,
`let_underscore_must_use`, `unwrap_in_result`, `panic` and `too_many_lines` in every
first-party file, and the panic lints (`unwrap_used`, `expect_used`, `indexing_slicing`,
`string_slice`, `get_unwrap`, `unreachable`) in `merkur-codec`, `merkur-fec`, `merkur-e2e`,
`apps/stun` and `apps/edge`. Vendored `packages/*-patch` crates carry no ratcheted lint.
Counts differ by platform, so the baseline names the host triple it was adopted on and is
compared only there; on any other host the run enforces the first class and says the
baseline was not compared. A build that does not finish, or output that is not Cargo's, is
unverified, never a pass.

`rust:test` is the broadest routine gate: it builds and runs test binaries for every
crate. Prefer `-p <crate>` with module filters; take the whole workspace only when the
change crosses crates.

Test builds use `[profile.test]` in the root `Cargo.toml`: opt-level 1 with line tables for
workspace crates, opt-level 3 for dependencies, debug assertions and overflow checks on. The
suites are CPU-bound simulations, so this took the dataplane suite from 78 s to 7 s with a
one-file incremental rebuild unchanged at ~3 s. The first build after a checkout or a
worktree is cold for dependencies (~1.5 min). Release, which the edge harness and shipped
binaries use, is unchanged.

## What the cheap gates cannot tell you

- **`check` and `test:unit` can both pass green while sessions are completely broken**:
  neither exercises real daemon-to-dataplane IPC or a real edge splice.
  `test:e2e:transport` is the only gate that does; run it after any IPC, framing,
  transport, or daemon-config change, not just before a release. `test:e2e:latency` is
  the fast single-spec variant; `:impaired` runs the `typical` network profile with 3%
  datagram loss and moderate reorder (the exact env is the script in `package.json`). No
  single command runs every spec; each belongs to one Playwright config, listed in the
  README's generated e2e table.
- `test:e2e` owns disposable server/account state and requires `build:dataplane` first for
  daemon identity link claims (CI prepares it explicitly); transport suites additionally start a live isolated daemon
  and edge.
- `test:e2e:rebind` is the only end-to-end proof of carrier rebind: it partitions the
  path through the delay proxy, types across the outage, and asserts the session returns
  with its terminal and its input applied once. It was materially flaky through 2026-08;
  the carrier-rebind fixes landed 2026-09-03..09 made it deterministic, so a red run is
  now a real signal.
- `test:natlab` (Docker, privileged Linux container) is the only place the side-channel
  punch and a v6 pinhole are proven rather than argued, because the lab owns the firewall.
- Generated artifacts must be rebuilt before they are tested or run: WASM is hash-pinned
  and `check:protocol` rejects stale provenance; the dev CLI executes the built dataplane
  binary, where staleness surfaces as unknown IPC frames or auth timeouts.

Benchmarks live behind `bench:*` and `profile:*`; `docs/performance.md` says which one
gates which claim; an outcome is a dated record and is not written into this tree.

## Gate selection rules

`bun run gates` matches every changed path against `RULES` in `scripts/gate-policy.ts` and
prints the batched commands with the selection reason for each path; `--run` executes them and
`--all` adds the deferred minutes-long suites. A change spanning rows runs the union. The table
is generated by `bun run generate:docs` from the same data and `check:docs` fails when it is
stale, so edit the rules, never the table. Rows marked "by hand" are the browser and Docker
harnesses and the long graphics convergence runs; use `--run --all` to execute them too. A
decoded image exists only in the sandboxed helper, so a change it can observe builds it first
(`build:image-worker`) and then runs the dataplane's `real_helper` modules against it. That is
every dataplane change: those modules drive the display simulator, which runs the connection,
session, network and crate-root code as well as the graphics owner.

<!-- generated:gate-rules -->
| Changed | Also run | Why |
| --- | --- | --- |
| `**/*.md`, `**/*.mdx`, `docs/**`, `.claude/**`, `.codex/**`, `.agents/**`, `LICENSE`, `.gitignore`, `.worktreeinclude` | `check:docs` only |  |
| `apps/web/**` | isolated source tests under `apps/web` |  |
| the `check:latency-boundaries` hot-path list, `apps/web/src/terminal/**`, `apps/web/src/transport/**`, `apps/web/src/perf/**`, `apps/web/src/*-worker.ts`, `apps/web/src/*-worker-client.ts`, `apps/web/src/*-worker-protocol.ts`, `apps/web/src/renderer-webgpu.ts`, `apps/web/src/terminal-renderer.ts`, `apps/web/src/wasm-loader.ts` (except `**/*.test.ts`, `**/*.test.tsx`) | by hand: `test:e2e:latency` | The browser hot path: the enforced latency-boundary list plus the directories the worker, prediction, display and render code lives in. A test file under those directories is not the render path; it does not earn the edge harness. |
| `apps/server/**` | isolated source tests under `apps/server` |  |
| `apps/server/src/**/*.dragonfly.test.ts`, `apps/server/src/http/daemon-request-auth.ts`, `apps/server/src/services/auth-flow-store.ts`, `apps/server/src/services/browser-session-presence.ts`, `apps/server/src/services/daemon-control-service.ts`, `apps/server/src/services/edge-registry-service.ts`, `apps/server/src/services/rate-limit-service.ts`, `apps/server/src/services/realtime-coordination-service.ts`, `apps/server/src/services/session-issuance-service.ts`, `apps/server/src/services/redis-*.ts` | by hand: `test:dragonfly` | Each source has a `*.dragonfly.test.ts` twin and the pair is updated together, so a change to either side implicates the container run. |
| `apps/daemon/src/**`, `apps/daemon/*.ts` | isolated source tests under `apps/daemon` |  |
| `apps/daemon/dataplane/src/**`, `apps/daemon/dataplane/Cargo.toml`, `apps/daemon/dataplane/build.rs` | `rust:lint`; `cargo test --locked -p merkur-dataplane` filtered to the changed modules | The cargo run is filtered to the changed modules: a directory module selects its subtree, a root-level file selects by name, and `main.rs`, the manifest or the build script select the whole crate. |
| `apps/edge/src/**`, `apps/edge/Cargo.toml` | `rust:lint`; `cargo test --locked -p merkur-edge` |  |
| `apps/stun/src/**`, `apps/stun/Cargo.toml`, `apps/server/src/services/stun-ticket-service.ts`, `apps/server/src/services/stun-ticket-service.test.ts` | `rust:lint`; `cargo test --locked -p merkur-stun`; isolated `apps/server/src/services/stun-ticket-service.test.ts`; then, by hand: `test:natlab` | The ticket format has two implementations pinned to one vector; nothing at runtime detects drift, so both suites run for a change on either side. |
| `apps/daemon/dataplane/src/network/**` | by hand: `test:natlab` |  |
| `apps/site/**` | isolated source tests under `apps/site`; then, by hand: `test:e2e:site` | The pages are proven only as served: `test:e2e:site` builds them and the static server, then reads the headers, the markup without script, the waitlist and the analytics proxy in a browser. |
| `apps/tui/**` | `rust:lint`; `cargo test --locked -p merkur-tui`; then, by hand: `test:e2e:transport` | The terminal client is proven only against a real splice: `tui-headless` drives the built binary in the transport phase. |
| `packages/auth/**` | isolated source tests under `packages/auth` |  |
| `packages/config/**` | isolated source tests under `packages/config` |  |
| `packages/daemon-control-protocol/**` | isolated source tests under `packages/daemon-control-protocol` |  |
| `packages/keyboard/**` | isolated source tests under `packages/keyboard` |  |
| `packages/logger/**` | isolated source tests under `packages/logger` |  |
| `packages/protocol/**` | isolated source tests under `packages/protocol` |  |
| `packages/quicksilver/**` | isolated source tests under `packages/quicksilver` |  |
| `packages/shared/**` | isolated source tests under `packages/shared` |  |
| `packages/user-agent/**` | isolated source tests under `packages/user-agent` |  |
| `packages/merkur-authorization/**` | `rust:lint`; `cargo test --locked -p merkur-authorization` |  |
| `packages/merkur-client/**` | `rust:lint`; `cargo test --locked -p merkur-client` |  |
| `packages/merkur-client-native/**` | `rust:lint`; `cargo test --locked -p merkur-client-native` |  |
| `packages/merkur-codec/**` | `rust:lint`; `cargo test --locked -p merkur-codec` |  |
| `packages/merkur-fec/**` | `rust:lint`; `cargo test --locked -p merkur-fec` |  |
| `packages/merkur-graphics/**` | `rust:lint`; `cargo test --locked -p merkur-graphics` |  |
| `packages/merkur-image-worker/**` | `rust:lint`; `cargo test --locked -p merkur-image-worker` |  |
| `packages/merkur-identity-seal/**` | `rust:lint`; `cargo test --locked -p merkur-identity-seal` |  |
| `packages/merkur-e2e/**` | `rust:lint`; `cargo test --locked -p merkur-e2e` |  |
| `packages/merkur-edge-protocol/**` | `rust:lint`; `cargo test --locked -p merkur-edge-protocol` |  |
| `packages/merkur-stun-protocol/**` | `rust:lint`; `cargo test --locked -p merkur-stun-protocol` |  |
| `packages/merkur-wire/**` | `rust:lint`; `cargo test --locked -p merkur-wire` |  |
| `packages/zstd-fixture/**` | `rust:lint`; `cargo test --locked -p zstd-fixture` |  |
| `packages/alacritty-terminal-patch/**` | `rust:lint`; `cargo test --locked -p alacritty_terminal` |  |
| `packages/vte-patch/**` | `rust:lint`; `cargo test --locked -p vte` |  |
| `packages/wtransport-patch/**`, `packages/quinn-patch/**`, `packages/quinn-proto-patch/**` | `rust:lint`; `cargo test --locked -p merkur-edge -p merkur-dataplane` | Patch targets, not workspace members: they resolve through their dependents, so their dependents' suites are the test surface. |
| `tools/sim/**`, `scripts/sim-tests.ts`, `scripts/generated-cargo-workspace.ts`, `apps/daemon/dataplane/src/**`, `apps/daemon/dataplane/Cargo.toml`, `apps/edge/src/**`, `apps/edge/Cargo.toml`, `packages/merkur-client/**`, `packages/merkur-client-native/**`, `packages/wtransport-patch/**`, `packages/quinn-patch/**`, `packages/quinn-proto-patch/**` (except `**/*.md`) | `test:sim` | The real client, edge and dataplane run whole sessions in one deterministic simulation (`tools/sim`); a change to any of them, or to the simulator, replays every scenario and its seeds. |
| `tools/bolero/**`, `scripts/fuzz-tests.ts`, `packages/merkur-wire/**`, `packages/merkur-codec/**`, `packages/merkur-client/**`, `packages/merkur-e2e/**` (except `**/*.md`) | by hand: `test:fuzz:kani` | The crates the Kani proofs compile, and their runner. The rebind keeper proof stubs `merkur-e2e` functions by signature, so a change anywhere in that crate can break it. |
| `packages/term-wasm/**`, `packages/term-wasm-pgo/**`, `packages/fontdue-patch/**`, `scripts/term-wasm-pgo.ts` | first `build:wasm`, then `sync:wasm`; `rust:lint`; `cargo test --locked -p term-wasm`; isolated source tests under `apps/web` | WASM artifacts are hash-pinned; the build precedes any test, and `check:protocol` is what rejects stale provenance. |
| `packages/merkur-e2e/**`, `packages/e2e-wasm/.cargo/**` | `test:wasm-cipher` | The browser transport cipher compiles only for wasm32, so a native `cargo test` never reaches it; its vectors and differential run inside wasm32 under Node. |
| `packages/e2e-wasm/**` | first `build:e2e-wasm`; `rust:lint`; isolated `packages/e2e-wasm/conformance.test.ts` |  |
| `packages/graphics-wasm/**`, `packages/merkur-graphics/src/tile.rs` | first `build:graphics-wasm`; `rust:lint`; `cargo test --locked -p graphics-wasm`; isolated `packages/graphics-wasm/conformance.test.ts` |  |
| `packages/graphics-codec-probe/**` | first `build:graphics-codec-probe`; `rust:lint`; `cargo test --locked -p graphics-codec-probe` |  |
| `packages/merkur-image-worker/**`, `packages/merkur-graphics/**`, `packages/merkur-codec/**`, `apps/daemon/dataplane/src/**`, `apps/daemon/dataplane/Cargo.toml`, `apps/daemon/dataplane/build.rs`, `Cargo.lock` | first `build:image-worker`; `cargo test --locked -p merkur-dataplane -- --ignored real_helper::`; then, by hand: `test:graphics:long` | Decoded images exist only in the sandboxed helper, which a dataplane test run does not build: the helper is built first, then the `real_helper` modules run against it. Those modules drive the display simulator through the connection, session, network and crate-root code as well as the graphics owner, so every dataplane change selects them. The 64-seed convergence runs spread their seeds across cores; the Kitty one is bound by the kernel launching sandboxed helpers. |
| `scripts/**` (except `scripts/natlab/**`) | isolated source tests under `scripts` | Selected tests whose import closure includes `scripts/perf/client-session-fixture.ts` prepare the source-and-binary SHA-256-pinned native session oracle once with `bun run scripts/prepare-client-session-oracle.ts` before the parallel Rust and Bun lanes; benchmark tests never invoke Cargo. |
| `biome.slop.json`, `tools/biome/slop/**` | isolated `scripts/check-slop.test.ts` | A rule is GritQL only Biome can judge: `tools/biome/slop/cases.json` holds what each rule reports, and the test runs every case through the invocation the gate uses. |
| `scripts/rust-lint.ts`, `scripts/lint-ratchet.ts`, `lint-baselines/clippy.json`, `clippy.toml` | `rust:lint`; isolated `scripts/rust-lint.test.ts`; isolated `scripts/lint-ratchet.test.ts` | What `rust:lint` answers with besides the Rust sources: the script that sorts Clippy's findings into classes, the ratchet it holds them to, the baseline, and Clippy's configuration. The tests cover the sorting and the comparison; only a Clippy run proves the workspace still meets them. |
| `tests/**` (except `tests/e2e/**/*.e2e.ts`) | isolated source tests under `tests` |  |
| `tests/e2e/**/*.e2e.ts`, `playwright*.config.mjs` | owning Playwright suite(s) | Select the spec’s owning Playwright configuration, including calibrated rebind/reorder runs. |
| `tests/e2e/**/*.ts` (except `tests/e2e/**/*.e2e.ts`, `**/*.test.ts`) | by hand: `test:e2e`, `test:e2e:transport`, `test:e2e:rebind`, `test:e2e:transport:reorder` | Shared fixture changes require their real browser consumers, as well as fixture unit tests. |
| `bunfig.toml`, `scripts/test-preload.ts`, `scripts/test-inventory*.ts`, `scripts/select-gates*.ts`, `scripts/gate-policy*.ts`, `scripts/verification-executor*.ts`, `scripts/verification-cargo*.ts`, `scripts/verification-junit*.ts`, `scripts/verification-cache*.ts`, `scripts/run-unit-tests.ts`, `scripts/run-verify.ts`, `scripts/run-rust-tests.ts`, `scripts/check-current-protocol.ts`, `scripts/protocol-gates.ts` | complete isolated source inventory | Runner, inventory and isolation changes must prove the complete source inventory. |
| `.bazelrc`, `.bazelversion`, `.bazelignore`, `MODULE.bazel`, `MODULE.bazel.lock`, `REPO.bazel`, `**/BUILD.bazel`, `BUILD.bazel`, `**/*.bzl`, `tools/bazel/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | `rust:lint`; complete isolated source inventory | Build graph, toolchain, package resolution and verification changes prove every source test and the complete Rust compilation scope. |
| `package.json`, `**/package.json`, `bun.lock` | `check:audit` |  |
| `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` | `rust:lint` | A workspace manifest or lockfile change recompiles every crate; `rust:lint` is the gate that proves the workspace still builds with no warning outside its baseline. |
| `packages/protocol/**`, `packages/daemon-control-protocol/**`, `packages/merkur-codec/**`, `packages/merkur-e2e/**`, `packages/merkur-authorization/**`, `packages/merkur-identity-seal/**`, `packages/merkur-wire/**`, `packages/merkur-edge-protocol/**`, `packages/merkur-client/**`, `packages/merkur-client-native/**`, `packages/e2e-wasm/**`, `packages/term-wasm/**`, `packages/merkur-stun-protocol/**`, `packages/shared/src/transport*.ts`, `packages/shared/src/display-stream*.ts`, `packages/shared/src/ipc*.ts`, `packages/shared/src/edge-*.ts`, `packages/shared/src/signaling/**`, `packages/shared/src/terminal.ts`, `packages/auth/src/session-authorization*.ts`, `packages/config/src/reconnect-policy*.ts`, `apps/daemon/dataplane/src/ipc/**`, `apps/daemon/dataplane/src/session/**`, `apps/daemon/dataplane/src/network/**`, `apps/daemon/dataplane/src/webtransport/**`, `apps/daemon/dataplane/src/auth.rs`, `apps/daemon/dataplane/src/connection.rs`, `apps/daemon/dataplane/src/edge_tunnel.rs`, `apps/daemon/dataplane/src/transport.rs`, `apps/daemon/dataplane/src/wt_upgrade.rs`, `apps/daemon/dataplane/src/display/wire.rs`, `apps/daemon/src/config.ts`, `apps/daemon/src/services/dataplane-client*.ts`, `apps/edge/src/**`, `apps/server/src/http/routes/edge-routes*.ts`, `apps/server/src/http/routes/session-routes*.ts`, `apps/server/src/services/edge-registry-service*.ts`, `apps/web/src/session/**`, `apps/web/src/transport/**`, `apps/web/src/lib/webtransport*.ts` | `check:protocol`; then, by hand: `test:e2e:transport` | Wire format, channel ids, IPC frames, crypto bootstrap and daemon config: every side of a contract, plus the daemon's IPC surface and config, which are protocol changes even when nothing under `packages/protocol` moved. |
| `apps/daemon/dataplane/src/display/**`, `apps/daemon/dataplane/src/input.rs`, `apps/daemon/dataplane/src/pty/**`, `apps/web/src/terminal/display-*.ts`, `apps/web/src/terminal-worker.ts`, `apps/web/src/transport-worker.ts`, `packages/shared/src/transport-policy.ts`, `scripts/run-edge-harness.ts` (except `**/*.test.ts`, `**/*.test.tsx`) | by hand: `test:e2e:transport` | Display scheduling, mirroring and transport policy are not wire changes, but the edge harness is the only gate that exercises them against a real splice. |
| `apps/daemon/dataplane/src/session/rebind_flow.rs`, `apps/daemon/dataplane/src/session/policy.rs`, `apps/daemon/dataplane/src/session/resume.rs`, `apps/daemon/dataplane/src/edge_tunnel.rs`, `apps/edge/src/splice.rs`, `apps/edge/src/relay.rs`, `packages/merkur-e2e/src/rebind.rs`, `packages/config/src/reconnect-policy.ts`, `packages/merkur-client/src/session*.rs`, `apps/web/src/session/session-state.ts`, `apps/web/src/transport/browser-client-session.ts`, `apps/web/src/transport/client-carrier.ts`, `apps/web/src/session/wake-detector.ts`, `tests/e2e/carrier-rebind.e2e.ts`, `packages/merkur-client/**`, `packages/merkur-client-native/**`, `apps/tui/**`, `tests/e2e/tui-rebind.e2e.ts`, `tests/e2e/fixtures/headless-client.ts` | by hand: `test:e2e:rebind` |  |
<!-- /generated:gate-rules -->

`gates`, `verify`, `test:unit`, and `check:protocol` share the planner and executor. The
source inventory includes `apps`, `packages`, `scripts`, and `tests`, excludes generated
`dist`/`target` trees, and passes explicit paths to Bun with up to eight isolated workers, bounded by available CPUs. A changed
test selects itself. A source module selects its owning suite, including tests that inspect
source text, and adds consumers across workspaces from compiler-parsed imports. Builds, Rust,
and browser harnesses use the table's explicit coverage rules. Deleted files and both endpoints
of renames participate in selection.

Protocol tests are merged with the selected unit inventory; each runs once. The hard-cut scan
and WASM provenance check precede the test lanes. Cargo crates and filters are merged, and full
transport coverage subsumes the identical latency command while calibrated rebind and reorder
remain separate. Auth specs select their actual Playwright configuration. Edge specs omitted
from the default harness phases receive an explicit spec filter. Output streams immediately
with completion status, duration, and outstanding-check counts. Each run saves logs, per-task
browser output directories, and a JSON report under `test-results/verification`; deferred
required checks remain pending until executed, so cheap-check success is not full verification.

E2E commands share `test-results/verification/web-artifacts` across plans and standalone
runs. Each browser build configuration has a content-addressed directory; source inputs and
output bytes are checked before reuse. Builds publish atomically from unique staging
directories; concurrent publishers validate the winner before discarding their own copy.
`PW_E2E_ARTIFACT_ROOT` can explicitly select a different store. Servers still get fresh
databases, Redis processes, accounts, and daemon fixtures. Build reuse never means session-state reuse. Each transport phase also owns a
separate result directory, so later phases cannot erase earlier failure traces.
`PW_E2E_OUTPUT_DIR` and `PW_E2E_ARTIFACT_ROOT` are harness-owned paths, not server
configuration.

The edge harness builds its edge binaries, dataplane and image worker in one Cargo command,
so shared transport dependencies use the same feature union throughout native preparation.
CI builds that set once per workflow and installs its verified manifest with
`bun run install:e2e-native-artifacts`; browser consumers do not compile it again. Required
functional transport coverage is partitioned across two runners at test level, with one worker
per runner. Calibrated rebind and reorder remain separate. CI job selection and artifact checks
are described in `docs/ci.md`; local test-result caches remain disabled in CI.
