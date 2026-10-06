# Development

How to get a Merkur checkout running on your machine on the first day: what to install,
the four commands that bring the stack up, what each development command starts, where
the tests live, and what a deployment needs. Building and testing detail lives in the docs
this page links.

## Prerequisites

Merkur is a Bun, TypeScript, and Rust monorepo. The toolchain is pinned in the repository,
so install the tools and let the pins pick the versions.

| Tool | Where the version is pinned | Why |
| --- | --- | --- |
| Bun | `packageManager` in `package.json` | Package manager, script runner, server runtime, and the daemon CLI's compile target. |
| Rust | `rust-toolchain.toml` (includes the `wasm32-unknown-unknown` target) | The dataplane, the edge, the STUN responder, the display codec, and the terminal WASM. |
| `wasm-pack` | Installed by `bun run setup` | Builds the WASM packages. The server and the daemon CLI embed `e2e-wasm`, their ML-DSA-87 and SHA-2 implementation. |
| LLVM (`clang` with the wasm32 target, `llvm-ar`) | Homebrew `llvm` on macOS; on Linux the release matching the pinned Rust's LLVM (22 today; `apt.llvm.org` on Debian, as the `Dockerfile` does) | `term-wasm` compiles libzstd for wasm32, and Apple clang has no WebAssembly backend. Its profile-guided build instruments that C, so an older clang (Debian bookworm's 14) leaves profiler symbols the Rust runtime does not define. |
| Docker with Compose | Any current release | Runs the local Redis and the container-based test labs. |
| Xcode Command Line Tools | macOS only | `swiftc` and a CryptoKit SDK for the Secure Enclave identity backend. |

## First run

Run everything from the repository root. Four commands take a fresh clone to a running
stack.

```bash
bun install
bun run infra:up # isolated Redis in Docker
bun run setup    # Git hooks + local env + required Rust/WASM artifacts
bun run dev      # edge + watched server + Vite
```

`bun run infra:up` starts one Redis container on `127.0.0.1:6379` from
`docker-compose.dev.yaml`. `bun run infra:down` stops it.

`bun run setup` is idempotent and safe to re-run. It creates `apps/server/.env` with
local-only keys when the file is absent and appends missing settings. Existing assignments
and identity keys are preserved; invalid or mismatched keys fail with a repair diagnostic.
The complete persisted candidate is validated before an atomic replacement with mode `0600`.
An exclusive `apps/server/.env.lock` serializes setup; after a killed setup, remove that
lock only after confirming its owner is no longer running. Setup adds the WASM target and
builds the terminal WASM,
the daemon dataplane, and the local edge. It also installs the pinned TruffleHog binary and
enables the pre-commit secret-scanning hook. It fails immediately when a required artifact
or service is unavailable.

Existing checkouts can run `bun run setup:hooks` alone to install the hook; `bun run
check:secrets` scans staged files on demand. The hook reads staged bytes, including partial
staging and `git commit -a`, and blocks a commit on findings or scanner errors. See the
[secret-scanning policy](../docs/security.md#repository-secret-scanning).

## Running the stack

`bun run dev` is the everyday command. It resolves and validates `apps/server/.env`, runs
the doctor, builds the local `merkur-edge` incrementally, starts the watched server, then
starts the edge with its matching registration key and waits for authenticated registration.
Vite starts after that registration. The edge registers its exact URL and current certificate pins with the
server. Ctrl-C shuts down the edge, server, and web processes together.

| Command | What it starts |
| --- | --- |
| `bun run dev` | Edge, watched server, Vite. |
| `bun run dev:server` | The same stack without Vite. |
| `bun run dev:web` | Vite alone, using the same validated configuration and proxy target. |
| `bun run dev:full` | `bun run dev` plus the linked local daemon, supervised in the same terminal. |
| `bun run dev:daemon` | The linked local daemon alone, in another terminal, on watch. |
| `bun run dev:doctor` | The health check `dev` runs first; run it alone to diagnose a failure. |

`bun run dev:full` requires `~/.merkur/config.json`, so link the machine once first: start
the stack with `bun run dev`, create a link token in the web app, and run the link command
it shows. It rebuilds the dataplane before starting the daemon and then watches
`apps/daemon/dataplane/src`: a saved `.rs` file triggers a debounced rebuild and restarts the
daemon on the new binary, while `bun --watch` reloads the daemon's TypeScript. A failed
rebuild leaves the daemon on its last good binary.

An installed daemon holds the single-instance lock, so stop it with `merkur stop` before
`dev:full` or `dev:daemon`. On macOS `merkur stop` leaves the machine without a daemon for
the rest of the boot session, so run `merkur start` when you are done to hand it back.

`bun run dev:doctor` resolves the same configuration, checks the pinned Bun and Rust
versions and artifact presence, and sends an authenticated Redis PING through Bun's
Redis client, including TLS for `rediss:` URLs. Artifact presence does not prove freshness;
`dev:full` builds before starting the daemon. Add `--sources` to report each supplied
setting's source without showing its value. Every failure names the repair.

### Configuration ownership

Local setup, development, doctor, and web builds disable Bun's implicit dotenv loading.
The resolver accepts dotenv exports, quoting, and comments. `$NAME`, `${NAME}`, and
`${NAME:-default}` expand against the file's assignments only; `\$` preserves a literal
dollar. Cycles fail with a key-only diagnostic. The last assignment to a key wins within
the file. Explicit process variables then override file values literally, including empty
values, so a supplied password containing `$` is never interpolated. Setup also validates
the persisted file without overrides, so the shell cannot conceal a broken file. A supplied
`REDIS_URL` is persisted when setup creates that missing setting.

The supervisor projects separate environments for the server, edge, daemon, and Vite.
Build tools receive operating-system and compiler inputs.
The child PATH prioritizes the running Bun and rustup proxies, and Bun script execution
uses the running runtime explicitly, so a system Rust or another Bun install cannot
replace the pinned tools. Vite receives only its public
build inputs and an explicit backend origin derived from the server's validated bind
address and port. It does not load another dotenv file. Its local listener uses port 3000
with strict port binding; the default server uses 3100. `PUBLIC_ORIGIN` describes the
browser-facing address, so it can be an HTTPS tunnel while Vite listens locally.

### Run scripts from the repository root

Always use `bun run <script>` at the root, or `bun run --cwd <dir> <script>` for a package
script. Never `cd` into a package and run `bunx <tool>`: inside a workspace package `bunx`
resolves against that package alone and can silently upgrade its dependencies.

## Everyday commands

| Command | What it does |
| --- | --- |
| `bun run check` | The static gates: types, lint, latency boundaries, span lifetimes and attributes, dead code, the ratchet, the anti-slop baseline, protocol, docs. |
| `bun run test:unit` | Every Bun unit test in the workspace. |
| `bun run test:e2e` | The hermetic Playwright suite (below). |
| `bun run rust:check`, `bun run rust:lint`, `bun run rust:test` | Cargo check, Clippy with no warning allowed outside the ratcheted lints of `lint-baselines/clippy.json`, and Cargo tests for the whole Rust workspace. |
| `bun run rust:all` | All three in one command. |
| `bun run rust:deps` | Unused and misplaced crate dependencies (`cargo shear`; install it once with `bun run setup:shear`). |
| `bun run gates` | Prints the tests a diff implicates and why; `--run` executes the cheap ones and `--run --all` adds the browser and container suites. |
| `bun run verify` | The pre-push gate. |

Build commands produce the same artifacts CI ships:

| Command | What it builds |
| --- | --- |
| `bun run build:web` | Resolves the local public OPAQUE pin, syncs terminal WASM, and runs Vite with public build inputs only. |
| `bun run build:server` | Compiles `apps/server/src/index.ts` to a Bun executable. |
| `bun run build:daemon` | The daemon JS entry plus the Rust dataplane artifact. |
| `bun run build:dataplane` | `merkur-dataplane` and `merkur-image-worker` in release mode, copied into the daemon's distribution directory. |
| `bun run build:image-worker` | `merkur-image-worker` alone, for the Rust tests that need it. |
| `bun run build:wasm` | The terminal, end-to-end crypto, and graphics WASM with a lockfile-matched `wasm-bindgen`. |
| `bun run sync:wasm` | Copies terminal WASM output into the web app source tree. |

The terminal WASM is profile-guided. `scripts/build-term-wasm.ts` first trains
`packages/term-wasm-pgo`, an instrumented plain-export module that links `term-wasm` as a
library, on the ingress benchmark's frames and their `zstd-fixture`-compressed twins
(`scripts/term-wasm-pgo.ts`). It then builds the shipped crate with `-Cprofile-use`. The training
build sets `RUSTC_BOOTSTRAP=1` for `-Zno-profiler-runtime`, because `minicov` supplies wasm32's
profile runtime, on the same pinned compiler, so the profile's function hashes match the stable
build. Training is deterministic, so two builds from one tree are byte-identical and the
provenance pin holds; the driver and fixture sources are provenance inputs.

Signing and deployment packaging commands are in [`docs/releases.md`](../docs/releases.md).

## Where the tests live

| Kind | Where | Runner |
| --- | --- | --- |
| TypeScript unit tests | `*.test.ts` next to the module under test, in every app and package | Bun test, through `bun run test:unit` |
| Rust unit and integration tests | Inside each crate | Cargo test, through `bun run rust:test` |
| Browser transport cipher | `packages/merkur-e2e/src/wasm_chacha.rs`, compiled only for wasm32 with simd128 | `wasm-bindgen-test` under Node, through `bun run test:wasm-cipher` |
| Browser end-to-end specs | `tests/e2e/*.e2e.ts`, with shared fixtures in `tests/fixtures` and helpers in `tests/helpers` | Playwright, through the `test:e2e*` commands |
| Container labs | `scripts/natlab` | Docker, through `bun run test:natlab` |

Every Playwright spec belongs to exactly one config, and no single command runs them all.
The inventory of suites, what each needs and proves, the network emulator's contract, and
the browser and TPM-simulator switches are in
[`docs/processes.md`](../docs/processes.md#end-to-end-tests).

## Testing

`bun run test:e2e` is the hermetic default. Playwright builds the web app with a fixed
test-only OPAQUE server-public-key pin, injects the matching test-only OPAQUE setup,
generates isolated access-token HMAC, ML-DSA-87 session, and edge-registration key material,
and starts isolated Bun server, database, and non-persistent Redis instances. It does not load
`apps/server/.env` or run live-daemon transport specs. Failure output is written under
`test-results/e2e` with screenshots, video, traces, and browser diagnostics.

Transport tests run a real edge and daemon and are explicit because they need the Rust
artifacts:

```bash
bun run test:e2e:transport                 # the live edge and daemon suite
bun run test:e2e:transport -- <spec|filter> # one spec or a Playwright filter
bun run test:e2e:cloud                     # the configured remote edge
bun run test:e2e:burst                     # the standalone browser burst harness
EDGE_URL=... EDGE_CERT_HASH=... bun run test:e2e:edge-probe  # the low-level edge probe
```

`bun run test:natlab` runs the NAT traversal labs in isolated Linux containers: the IPv6
punch and pinhole mechanism, the IPv4 port-dependent filter behind a conntrack masquerade
that no adjacent-port punch opens, and the Rust STUN and WebTransport discovery
lab. It covers translated ports, mapping changes on a live listener, restricted firewalls,
a plain masquerade, and packet loss.
[The STUN guide](../apps/stun/README.md#verify-locally) runs the discovery lab alone.

`bun run setup:audit` installs cargo-audit; `bun run check:audit` checks JavaScript and
Rust dependencies, including yanked Rust releases. The
[dependency audit workflow](../.github/workflows/dependency-audit.yml) runs the same checks
on pull requests, pushes to `main`, a daily schedule, and manual dispatch.
[Secret scanning](../.github/workflows/secret-scanning.yml) runs TruffleHog on every push
and pull request. What CI gates on which trigger is in [`docs/ci.md`](../docs/ci.md), and
hot-path benchmarks, profiler runs, and soak runs are in
[`docs/performance.md`](../docs/performance.md).

## Infrastructure and deployment

Merkur runs as a small set of services around one invariant: the application server is
never in the terminal hot path. This is what a deployment needs.

| Component | Requirement |
| --- | --- |
| Bun | Server runtime and the runtime the daemon CLI is compiled with. |
| Rust | Builds the daemon dataplane, the edge relay, the STUN responder, the display codec, and the terminal WASM. |
| `wasm32-unknown-unknown`, `wasm-pack`, and a wasm32-capable `clang` | Build the WASM packages, including `packages/term-wasm`, which links libzstd, and `packages/e2e-wasm`, which the server and daemon executables embed. |
| libSQL | The server's durable database, reached through `DB_URL`. A `file:` URL opens a local database in-process, defaulting to `file:./data/merkur.db`; `http(s)://` or `libsql://` reach a libSQL server, which is what production runs so more than one process can share one database. |
| Redis or Dragonfly | The realtime coordination backend, reached through `REDIS_URL`. |
| Merkur edge | A registered blind WebTransport relay. Every replica publishes its exact URL and current certificate pins to the server. |
| Merkur STUN | A reachable authenticated Binding responder. At least two `host:port` vantage points on independent addresses must be configured, because NAT mapping classification needs two observers; one IP cannot establish address independence. |
| HTTPS public origin | Required outside loopback development. WebTransport, service workers, secure cookies, browser crypto, and `SharedArrayBuffer` isolation all depend on a secure context and the server's cross-origin isolation headers. |

The Dockerfile exports the server, migrations, and web artifacts through its `artifacts`
target. After CI signing, the default target verifies the complete bundle before packaging
it and does not rebuild signed assets; see
[signed deployment](../docs/releases.md#signed-docker-deployment). Production needs
a separate durable libSQL service, a Redis-compatible private URL, the secrets in the
[Configuration](../README.md#configuration) table, at least two `STUN_SERVERS` vantage
points, and a web image built with the same OPAQUE public key it serves. At startup the
server derives the public key from `OPAQUE_SERVER_SETUP` and compares it with
`OPAQUE_SERVER_PUBLIC_KEY` and the pin compiled into the executable before it runs
migrations, so a stale image fails closed. Build arguments, the runtime image, and the
signing steps are in [`docs/releases.md`](../docs/releases.md).

[Back to Merkur](../README.md).
