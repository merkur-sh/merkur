---
name: verify
description: Select and batch Merkur's verification gates for a change - which bun test, bazel test, check:*, test:e2e:*, or test:natlab command a change under apps/*, packages/*, protocol, IPC, Rust, or WASM implicates, how to batch them, their warm cost, and what the cheap gates cannot prove. Use before running tests, when asked what to run, to verify, run the gates, or before reporting a change done.
---

# Verifying a change

**CI verifies; this machine runs the narrowest proof** (AGENTS.md Verification). Locally,
run the one test file or filtered `bazel test` that reproduces the failure and then passes;
commit, push, and follow the CI run. Tree-wide runs (the static gates, `gates --run`,
suites, e2e) happen locally only when the owner asks for one. This skill is the reference
for what each plan and gate proves, how to read `bun run gates`, and how to batch a run the
owner asked for.

Verification is **one cached graph**: every unit test and static gate is a Bazel test, and
`bazel test //...` runs only the ones whose declared inputs changed, answering the rest from
the local cache or the BuildBuddy remote cache CI fills. Re-running it with no edit between
costs seconds. Do not guess at an answer the print-only plan gives: "what does this change
earn?" is `bun run gates`, which runs nothing.

Start with `bun run gates`: it reads the working tree (or `--base <ref>`, or `--files a,b`),
matches every changed path against `RULES` in `scripts/gate-policy.ts`, and prints the
commands with the selection reason for each path. Any change but prose earns
`bazel test //...`; a row adds what Bazel does not run: the dependency audit, and the
deferred browser, container and proof suites. `--run` executes the
commands in order and stops at the first failure; `--all` also runs the deferred suites.
Rows printed "by hand" are the browser and Docker harnesses and the long graphics
convergence runs. The rules are rendered as a table below; edit the rules, never the table.

## How a Bun test runs under Bazel

`bun_test_files` (`tools/bazel/bun/bun.bzl`) is one test per test file, `//<package>:<file
without .ts>`, and a `//<package>:test` suite of them; `bazel test //apps/web:src/api.refresh.test`
runs one. Each copies exactly what its file loads (its `<path>.module` target in
`tools/bazel/modules.bzl`: imports, literal `new URL(…, import.meta.url)` names, the nearest
`package.json` and `tsconfig.json`) plus `bunfig.toml`'s preloads into a checkout of its own, so
it reruns only when one of those changed. `node_modules` hold the third-party packages as links
into rules_js's store, with the `.bin` commands pnpm would write; workspace packages link to the
checkout's own directories. What else a file reads, runs or spawns is declared in
`bun_test_files`'s `files` (`data`, `tools`, `browsers`, `checkout`); an undeclared read fails
with ENOENT or "Module not found" for a path under the checkout. Bun, Node (the release
`.node-version` names), Redis and OpenSSL, and the Playwright Chromium revision
`playwright-core` names are hermetic. A native helper a script spawns (the display fixture, the
session oracle) is a declared tool on `PATH`; run from the checkout, `scripts/bazel-tool.ts`
builds it with `--config=release`.

`scripts/bazel-sources.ts` generates `tools/bazel/sources.bzl` (the package list `//:sources`
gathers, each importer's dependencies) and `tools/bazel/modules.bzl` (the module graph), and
`check:bazel-sources` (`//:check_bazel_sources`) fails when either is stale or a `BUILD.bazel`
declares no `package_files()`. Rerun it after changing an import, a test file or a
`BUILD.bazel`.

## The static gates

`bun run check:secrets` is a separate, networked scan of staged file contents using the
pinned TruffleHog binary installed by `bun run setup:hooks` (also part of `bun run setup`).
The pre-commit hook runs it automatically; CI independently scans pushed/PR commit ranges.
It is not one of the nine static gates, and an empty index is not a repository audit.
See `docs/security.md` for the failure policy and full-history audit command.

Native tsc, Biome over the whole repo, five single-process source scans, the fallow
ratchet, and the anti-slop baseline. Each is the `package.json` script of its name and a
Bazel test of the same name with `-` for `:` (`//:check_lint`), which runs the script over a
checkout of the whole repository that is a Git repository, so the gates see what Git ignores
as a working tree does. `//:check_types` is instead a suite of one test per TypeScript
project (`//:check_types/apps/web/tsconfig.json`), each over the files that project's `tsc`
lists (`TYPE_PROJECTS` in `tools/bazel/modules.bzl`), so only the projects a change reaches
check again, and `//:check_lint` and `//:check_slop` are one test per Bazel package
(`//:check_slop/apps/web/BUILD.bazel`, `//:check_slop/BUILD.bazel` for the root's), each over
that package's own files against the baseline entries it owns. `rust:lint`,
`check:latency-boundaries` and the two span checks run over only the parts of the repository
they read. `//:static_gates` is all of them; `bun run check` is them plus
`check:protocol`. CI runs them on every push inside `bazel test //...`:

```
bazel test //:static_gates
```

`check:ratchet` holds the whole tree to `fallow-baselines/`: dead code to `dead-code.json`,
which fallow matches by name, exact clones to `dupes.json`, each file's count of clone
instances, which holds whatever moves inside or around a clone, and every function over the
complexity thresholds to its exact values in `complexity-ceilings.json`. Anything the
baselines do not hold fails, and so does a hotspot that grew. A dead-code entry the tree no
longer has, a file with fewer clones, or a hotspot that shrank fails as loose until
`bun run check:ratchet --tighten` lowers the baselines; `--tighten` refuses while the tree
has a finding they do not hold, so it never adds one. The pre-commit hook runs it with
`--staged`: `fallow audit` against HEAD for what the staged diff introduces, plus the
ceilings of the files it touches, refusing a staged non-prose file that also has unstaged
edits. Renamed-identifier clones print there as notes and never fail.

`check:slop` runs the anti-slop rules over the tree and compares the findings, per file and
per rule, with `lint-baselines/anti-slop.json`. There are two sets. The Biome rules are
GritQL plugins, one file each under `tools/biome/slop/`, listed by `biome.slop.json`, over
script files; `check:lint` does not load them. The comment rules
(`scripts/comment-rules.ts`, named `comment-…`) read the comments of script files and of
first-party Rust: the phrases that put off or doubt what the code does ("for now",
"temporary", "should work", "hopefully"), the code's history ("used to be", "the previous
implementation"), guards against an unnamed case ("just in case", "defensively",
"best-effort"), a `SAFETY:` comment whose whole reason is "safe", and `TODO` or `FIXME` in a
comment that holds no URL. Biome's own type-aware rules are not among the Biome set:
`noUnnecessaryConditions` ignores `noUncheckedIndexedAccess` and reports `while (true)`. A
file or rule the baseline does not name is allowed nothing, so new code meets every
rule; a count above its entry fails and prints each finding with the rule's message, which
is the repair instruction. The baseline is never raised: fix the code. A count below its
entry, or an entry for a deleted file, fails too until `bun run check:slop --tighten` lowers
it, and `--tighten` refuses to raise or add an entry. A `biome-ignore` comment that names
`lint` as a whole or `lint/plugin` fails as well: no rule is suppressed, while a suppression
of one built-in rule (`lint/suspicious/noConsole`) is not the gate's business. The pre-commit
hook runs it with `--staged`, over the files in the index only.

Prose has its own rules (`scripts/prose-rules.ts`: "not X, it's Y" reveals, stock words such
as `seamless` and `robust`, filler frames, bold labels before a colon), with no baseline:
`check:docs` holds every first-party Markdown file to them, and the `commit-msg` hook holds
the commit message to them and refuses an AI attribution trailer
(`scripts/check-commit-message.ts`). A skill installed from another repository, named in
`skills-lock.json`, is not read.

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
row matches (a systemd unit, a Dockerfile) still earns `bazel test //...`. `build:native` is
not a gate: run it only when something will *execute* the programs (dev CLI, a harness run
outside the harness scripts, which sync themselves), never to satisfy a test: Bazel builds
what each test declares.

## Batch what you selected

Process spawns dominate small runs.

- While editing, `bun run test:quick` (`bazel test --config=quick //...`) runs every test whose
  inputs changed except the eighteen tagged `repository`, which read the whole repository and
  rerun after any edit; `bazel test //...` before the push runs them too.
- One `bazel test` invocation takes every target: Bazel builds what they share once, runs the
  tests side by side, and prints a failing test's log when it finishes. libtest filters pass through `--test_arg`:
  `bazel test //apps/daemon/dataplane:unit --test_arg=session::rebind_flow::tests --test_arg=network::peer::tests`.
  Several packages share an invocation too: `bazel test //packages/merkur-e2e/... //apps/edge/...`.
- Never run `check` plus one of its members.
- Bazel serializes on its server, so a second `bazel` command in the same checkout waits for
  the first.

The hooks in `.claude/settings.json` / `.codex/hooks.json` refuse the redundant combinations
and a backgrounded second Cargo command on one command line.

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

Warm on a 14-core machine, measured 2026-08-26 for the scripts run directly. As Bazel tests,
each also copies its checkout first (about twenty seconds); an unchanged one is a cache hit.
Cold, or after a broad Rust change, the builds grow by an order of magnitude.

| Command | Covers | Warm |
| --- | --- | --- |
| `check:types` | native tsc, `--noUnusedLocals --noUnusedParameters` | <1 s |
| `check:lint` | Biome | <1 s |
| `check:latency-boundaries` | hot-path modules importing `effect` | <1 s |
| `check:span-lifetimes` | `Effect.withSpan` composed with a non-returning effect | <1 s |
| `check:span-attributes` | code bypassing the typed span attribute map, and edge field drift | <1 s |
| `check:dead` | `check:files` reachability + `fallow` unused exports/types | <1 s |
| `check:ratchet` | the tree's dead code, exact clones and hotspots against `fallow-baselines/`; its three fallow analyses run concurrently | ~1 s (2026-10-03) |
| `check:slop` | anti-slop findings per file and rule against `lint-baselines/anti-slop.json`; Biome with the GritQL rule plugins, over the script files whose bytes are new, and the comment rules over script and Rust files | <1 s; ~16 s when every file is linted (2026-10-05) |
| `check:docs` | prose paths, links, pinned facts, config/e2e/workspace parity, harness shape | <1 s |
| `check:bazel-sources` | `tools/bazel/sources.bzl` matches the packages, and each declares `package_files()` | <1 s |
| `check:protocol` | `bazel test //:protocol`: every suite holding a side of a wire, IPC, crypto or config contract | seconds when nothing changed |
| `check` | `bazel test //:static_gates //:protocol` | seconds when nothing changed |
| `test:unit` | `bazel test //...` | seconds when nothing changed |
| `check:audit` | pnpm and Cargo dependency advisories and yanked Rust releases; install cargo-audit with `setup:audit`; needs network | network |
| `check:js-dependency-policy` | `pnpm-lock.yaml` sources, specs, licenses and install-script trust, read from a script-free install for every platform any locked package names, in `target/js-dependency-policy`; runs beside `check:audit` | seconds on a warm pnpm store |
| `rust:lint` | `bazel test //:rust_lint`: Clippy over every first-party target as a Bazel aspect, cached per crate, sorted by `scripts/rust-lint.ts`. No warning is allowed outside the ratcheted lints, which are held per file and lint to `lint-baselines/clippy.json`. A suppression is `#[expect(lint, reason = "…")]`, and one the lint no longer meets fails | seconds when no crate changed; minutes cold |
| `rust:deps` | `cargo shear`: unused or misplaced crate dependencies; install it with `setup:shear` | ~1 s |
| `bazel test //apps/daemon/dataplane:unit --test_arg=<filter>` | one filtered dataplane run, the `real_helper` modules included when the filter selects them: the test target builds the sandboxed image helper and hands its path over | seconds warm |
| `rust:test` | `bazel test` over every Rust target: each crate's unit, integration and doc tests, the dataplane's `real_helper` modules, and `term-wasm` again in the release profile | seconds when nothing changed |
| `test:graphics:long` | 64-seed convergence, both drivers, seeds across cores | ~20 s (2026-09-29) |
| `build:native` | `bazel run //tools/bazel/native:sync`, in the release profile whatever the command line's configuration: the dataplane, image worker and terminal client into apps/daemon/dist, the edge, delay proxy and bulk competitor into apps/edge/dist | seconds when nothing changed |
| `build:web` `build:server` `build:daemon` `build:wasm` | artifacts | — |
| `bench:reconnect` | carrier-recovery latency per failure scenario, in process | ~3.5 min |
| `--cwd apps/server telemetry:smoke` | server telemetry wire contract | — |
| `test:dragonfly` | `*.dragonfly.test.ts` against a real container; starts it and injects `DRAGONFLY_TEST_URL` | — |
| `test:e2e:*`, `test:natlab`, `bench:*`, `profile:*` | see below | minutes |

`rust:lint` (`//:rust_lint`, inside `bazel test //...`) lints every first-party target with Clippy
as a Bazel aspect (`--cap-lints warn`, JSON out, cached per crate) and `scripts/rust-lint.ts`
sorts every finding into one class. Nothing allows a compiler
warning, a default Clippy lint, a lint of `[workspace.lints]`, an `#[expect]` its lint no
longer meets, a panic lint in `merkur-wire`, `merkur-stun-protocol` and
`merkur-edge-protocol`, tests included, or a timer call in a module on a latency path
(`clippy.toml` lists the calls; each such module denies them at the head of its file, tests
exempt): fix the code, or expect the lint where it fires.
Each is printed as the compiler rendered it. Clippy lints first-party targets only, so a
warning in a `[patch]` crate crate_universe builds is not a finding. The ratcheted lints
are counted per file and lint against `lint-baselines/clippy.json` on the terms of
`check:slop`: a file or lint the baseline does not name is allowed nothing, the baseline is
never raised, and a count that dropped fails until `bazel run //:rust_lint -- --tighten`. They are
`cast_possible_truncation`, `cast_sign_loss`, `cast_possible_wrap`, `map_err_ignore`,
`let_underscore_must_use`, `unused_result_ok`, `wildcard_enum_match_arm`, `unwrap_in_result`,
`panic` and `too_many_lines` in every
first-party file, and the panic lints (`unwrap_used`, `expect_used`, `indexing_slicing`,
`string_slice`, `get_unwrap`, `unreachable`) in `merkur-codec`, `merkur-fec`, `merkur-e2e`,
`apps/stun` and `apps/edge`. Vendored `packages/*-patch` crates carry no ratcheted lint.
Counts differ by platform, so the baseline names the host triple it was adopted on and is
compared only there; on any other host the run enforces the first class and says the
baseline was not compared. A build that does not finish, or output that is not rustc's, is
unverified, never a pass.

`rust:test` is the broadest routine gate: it builds and runs every Rust test target. Prefer
one crate's package with module filters; take the whole workspace only when the change
crosses crates.

Test builds use Bazel's default `fastbuild`, which `MODULE.bazel` and `.bazelrc` make Cargo's
test profile: opt-level 1 with line tables for workspace crates, opt-level 3 for
dependencies, debug assertions and overflow checks on. The
suites are CPU-bound simulations, so this took the dataplane suite from 78 s to 7 s with a
one-file incremental rebuild unchanged at ~3 s. The first build after a checkout or a
worktree is cold for dependencies unless the remote cache holds them. Cargo's release profile is
`--config=release`, or a `release_binary` target that takes it from any command line: the native
sync, `//apps/daemon/dataplane:unit_release` for the benchmarks, and shipped binaries. Prefer the
target: changing `--config` between commands discards Bazel's analysis cache.

## What the cheap gates cannot tell you

- `check` and `test:unit` can both pass green while sessions are completely broken,
  because neither exercises real daemon-to-dataplane IPC or a real edge splice.
  `test:e2e:transport` is the only gate that does; run it after any IPC, framing,
  transport, or daemon-config change, not just before a release. `test:e2e:latency` is
  the fast single-spec variant; `:impaired` runs the `typical` network profile with 3%
  datagram loss and moderate reorder (the exact env is the script in `package.json`). No
  single command runs every spec; each belongs to one Playwright config, listed in the
  README's generated e2e table.
- `test:e2e` owns disposable server/account state; the suites whose global setup links a
  daemon sync the native programs first, and the transport suites additionally start a live
  isolated daemon and edge.
- `test:e2e:rebind` is the only end-to-end proof of carrier rebind: it partitions the
  path through the delay proxy, types across the outage, and asserts the session returns
  with its terminal and its input applied once. It was materially flaky through 2026-08;
  the carrier-rebind fixes landed 2026-09-03..09 made it deterministic, so a red run is
  now a real signal.
- `test:natlab` (Docker, privileged Linux container) is the only place the side-channel
  punch and a v6 pinhole are proven rather than argued, because the lab owns the firewall.
- Generated artifacts must be rebuilt before they are run outside Bazel: Vite and the dev CLI
  read the synced `pkg/` directories and apps/daemon/dist, where staleness surfaces as
  unknown IPC frames or auth timeouts. `bun run dev` and the harnesses sync first.

Benchmarks live behind `bench:*` and `profile:*`; `docs/performance.md` says which one
gates which claim; an outcome is a dated record and is not written into this tree.

## Gate selection rules

`bun run gates` matches every changed path against `RULES` in `scripts/gate-policy.ts` and
prints the commands with the selection reason for each path; `--run` executes them and `--all`
adds the deferred minutes-long suites. Every row but prose implies `bazel test //...`; the
table names what a row adds, and a change spanning rows runs the union. The table is generated
by `bun run generate:docs` from the same data and `check:docs` fails when it is stale, so edit
the rules, never the table. Rows marked "by hand" are the browser and Docker harnesses and the
long graphics convergence runs; use `--run --all` to execute them too.

<!-- generated:gate-rules -->
| Changed | Also run | Why |
| --- | --- | --- |
| `**/*.md`, `**/*.mdx`, `docs/**`, `.claude/**`, `.codex/**`, `.agents/**`, `LICENSE`, `.gitignore`, `.worktreeinclude` | `bazel test //:check_docs` only |  |
| the `check:latency-boundaries` hot-path list, `apps/web/src/terminal/**`, `apps/web/src/transport/**`, `apps/web/src/perf/**`, `apps/web/src/*-worker.ts`, `apps/web/src/*-worker-client.ts`, `apps/web/src/*-worker-protocol.ts`, `apps/web/src/renderer-webgpu.ts`, `apps/web/src/terminal-renderer.ts`, `apps/web/src/wasm-loader.ts` (except `**/*.test.ts`, `**/*.test.tsx`) | by hand: `test:e2e:latency` | The browser hot path: the enforced latency-boundary list plus the directories the worker, prediction, display and render code lives in. A test file under those directories is not the render path; it does not earn the edge harness. |
| `apps/server/src/**/*.dragonfly.test.ts`, `apps/server/src/http/daemon-request-auth.ts`, `apps/server/src/services/auth-flow-store.ts`, `apps/server/src/services/browser-session-presence.ts`, `apps/server/src/services/daemon-control-service.ts`, `apps/server/src/services/edge-registry-service.ts`, `apps/server/src/services/rate-limit-service.ts`, `apps/server/src/services/realtime-coordination-service.ts`, `apps/server/src/services/session-issuance-service.ts`, `apps/server/src/services/redis-*.ts` | by hand: `test:dragonfly` | Each source has a `*.dragonfly.test.ts` twin and the pair is updated together, so a change to either side implicates the container run. |
| `apps/daemon/dataplane/src/network/**`, `apps/daemon/dataplane/src/webtransport/**`, `packages/merkur-traversal/**`, `packages/merkur-stun-protocol/**`, `packages/merkur-client-native/src/traversal/**`, `packages/merkur-client-native/src/traversal*.rs`, `packages/merkur-client/src/session/direct.rs`, `packages/merkur-client/src/session.rs`, `packages/merkur-client-native/src/carrier.rs`, `packages/merkur-client-native/src/driver.rs`, `packages/merkur-client-native/src/path_hints.rs`, `scripts/natlab/**`, `apps/stun/src/**`, `apps/stun/Cargo.toml`, `apps/server/src/services/stun-ticket-service.ts`, `apps/server/src/services/stun-ticket-service.test.ts` | by hand: `test:natlab`, `test:e2e:handover` | Ticket and receipt formats are pinned to cross-language vectors; the lab proves traversal across controlled NATs, and handover proves the admitted browser and native paths. |
| `apps/site/**` | by hand: `test:e2e:site` | The pages are proven only as served: `test:e2e:site` builds them and the static server, then reads the headers, the markup without script, the waitlist and the analytics proxy in a browser. |
| `apps/tui/**` | by hand: `test:e2e:transport` | The terminal client is proven only against a real splice: `tui-headless` drives the built binary in the transport phase. |
| `tools/bolero/**`, `scripts/fuzz-tests.ts`, `packages/merkur-wire/**`, `packages/merkur-codec/**`, `packages/merkur-client/**`, `packages/merkur-e2e/**` (except `**/*.md`) | by hand: `test:fuzz:kani` | The crates the Kani proofs compile, and their runner. The rebind keeper proof stubs `merkur-e2e` functions by signature, so a change anywhere in that crate can break it. |
| `packages/merkur-image-worker/**`, `packages/merkur-graphics/**`, `packages/merkur-codec/**`, `apps/daemon/dataplane/src/**`, `apps/daemon/dataplane/Cargo.toml`, `apps/daemon/dataplane/build.rs`, `Cargo.lock` | by hand: `test:graphics:long` | The 64-seed convergence runs spread their seeds across cores; the Kitty one is bound by the kernel launching sandboxed helpers. |
| `tests/e2e/**/*.e2e.ts`, `playwright*.config.mjs`, `scripts/**/playwright*.config.mjs` | owning Playwright suite(s) | Select the spec’s owning Playwright configuration, including calibrated rebind/reorder runs. |
| `tests/e2e/**/*.ts`, `scripts/native-artifacts.ts` (except `tests/e2e/**/*.e2e.ts`, `**/*.test.ts`) | by hand: `test:e2e`, `test:e2e:transport`, `test:e2e:rebind`, `test:e2e:transport:reorder` | Shared fixture changes require their real browser consumers, as well as fixture unit tests. |
| `package.json`, `**/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | `check:audit`; `check:js-dependency-policy` |  |
| `packages/protocol/**`, `packages/daemon-control-protocol/**`, `packages/merkur-codec/**`, `packages/merkur-e2e/**`, `packages/merkur-authorization/**`, `packages/merkur-identity-seal/**`, `packages/merkur-wire/**`, `packages/merkur-edge-protocol/**`, `packages/merkur-client/**`, `packages/merkur-client-native/**`, `packages/e2e-wasm/**`, `packages/term-wasm/**`, `packages/merkur-stun-protocol/**`, `packages/merkur-traversal/**`, `packages/shared/src/transport*.ts`, `packages/shared/src/display-stream*.ts`, `packages/shared/src/ipc*.ts`, `packages/shared/src/edge-*.ts`, `packages/shared/src/signaling/**`, `packages/shared/src/terminal.ts`, `packages/auth/src/session-authorization*.ts`, `packages/config/src/reconnect-policy*.ts`, `apps/daemon/dataplane/src/ipc/**`, `apps/daemon/dataplane/src/session/**`, `apps/daemon/dataplane/src/network/**`, `apps/daemon/dataplane/src/webtransport/**`, `apps/daemon/dataplane/src/auth.rs`, `apps/daemon/dataplane/src/connection.rs`, `apps/daemon/dataplane/src/edge_tunnel.rs`, `apps/daemon/dataplane/src/transport.rs`, `apps/daemon/dataplane/src/wt_upgrade.rs`, `apps/daemon/dataplane/src/display/wire.rs`, `apps/daemon/src/config.ts`, `apps/daemon/src/services/dataplane-client*.ts`, `apps/edge/src/**`, `apps/server/src/http/routes/edge-routes*.ts`, `apps/server/src/http/routes/session-routes*.ts`, `apps/server/src/services/edge-registry-service*.ts`, `apps/web/src/session/**`, `apps/web/src/transport/**`, `apps/web/src/lib/webtransport*.ts` | by hand: `test:e2e:transport` | Wire format, channel ids, IPC frames, crypto bootstrap and daemon config: every side of a contract, plus the daemon's IPC surface and config, which are protocol changes even when nothing under `packages/protocol` moved. `bazel test //...` holds every contract test; only the edge harness proves a live session. |
| `apps/daemon/dataplane/src/display/**`, `apps/daemon/dataplane/src/input.rs`, `apps/daemon/dataplane/src/pty/**`, `apps/web/src/terminal/display-*.ts`, `apps/web/src/terminal-worker.ts`, `apps/web/src/transport-worker.ts`, `packages/shared/src/transport-policy.ts`, `scripts/run-edge-harness.ts` (except `**/*.test.ts`, `**/*.test.tsx`) | by hand: `test:e2e:transport` | Display scheduling, mirroring and transport policy are not wire changes, but the edge harness is the only gate that exercises them against a real splice. |
| `apps/daemon/dataplane/src/session/rebind_flow.rs`, `apps/daemon/dataplane/src/session/policy.rs`, `apps/daemon/dataplane/src/session/resume.rs`, `apps/daemon/dataplane/src/edge_tunnel.rs`, `apps/edge/src/splice.rs`, `apps/edge/src/relay.rs`, `packages/merkur-e2e/src/rebind.rs`, `packages/merkur-traversal/**`, `packages/config/src/reconnect-policy.ts`, `packages/merkur-client/src/session*.rs`, `apps/web/src/session/session-state.ts`, `apps/web/src/transport/browser-client-session.ts`, `apps/web/src/transport/client-carrier.ts`, `apps/web/src/session/wake-detector.ts`, `tests/e2e/carrier-rebind.e2e.ts`, `packages/merkur-client/**`, `packages/merkur-client-native/**`, `apps/tui/**`, `tests/e2e/tui-rebind.e2e.ts`, `tests/e2e/fixtures/headless-client.ts` | by hand: `test:e2e:rebind` |  |
<!-- /generated:gate-rules -->

Full transport coverage subsumes the identical latency command, while calibrated rebind and
reorder remain separate. Auth specs select their actual Playwright configuration. Edge specs
omitted from the default harness phases receive an explicit spec filter. Deleted files and
both endpoints of renames participate in selection.

E2E commands share `test-results/verification/web-artifacts` across runs. Each browser build
configuration has a content-addressed directory; source inputs and output bytes are checked
before reuse. Builds publish atomically from unique staging directories; concurrent
publishers validate the winner before discarding their own copy. `PW_E2E_ARTIFACT_ROOT` can
explicitly select a different store. Servers still get fresh databases, Redis processes,
accounts, and daemon fixtures. Build reuse never means session-state reuse. Each transport
phase also owns a separate result directory, so later phases cannot erase earlier failure
traces. `PW_E2E_OUTPUT_DIR` and `PW_E2E_ARTIFACT_ROOT` are harness-owned paths, not server
configuration.

The edge harness syncs the native programs once (`scripts/native-artifacts.ts`), records each
one's SHA-256 in its result, gives its Playwright phases the same bytes, and fails the run if
any changed before it ended; a suite Playwright starts itself syncs in its global setup, and
`MERKUR_TPM_SIM_ADDR` builds the TPM simulator transport. CI builds the programs and the
WebAssembly packages once into the remote cache, and each browser job's sync is a cache hit.
Required functional transport coverage is partitioned across runners at test level, with one
worker per runner. CI's jobs are described in `docs/ci.md`.
