# AGENTS.md

Claude Code reads this through `CLAUDE.md`; Codex reads it directly. The gate caps it at
12 KB. Read the tree-specific `.claude/rules/*.md` and procedures in `.claude/skills/`
(also `.agents/skills/`) named by the index for the tree you edit.

## What Merkur Is

A Bun, TypeScript, SolidJS, Elysia, Effect, and Rust monorepo for secure browser access to
a local terminal. **The architectural invariant:** the application server coordinates
auth, devices, presence, and short-lived session issuance, but is never in the PTY or
terminal-display hot path. A persistent authenticated WSS connection between each daemon
and the server carries registration, heartbeat, and session commands. Terminal traffic
flows between browser and local daemon through the blind WebTransport edge, with optional
direct WebTransport upgrade. The Rust dataplane owns the latency-sensitive path. A "box"
is that same daemon inside a container on a box host, which the server reaches at
`BOX_HOST_URL`; it adds no transport, no auth path, no data plane.

## Map

| Path | What it is | Read first |
| --- | --- | --- |
| `apps/web`, `packages/quicksilver` | SolidJS/Vite app; main thread owns UI and input, workers own transport, terminal, telemetry; Quicksilver design system | rules `frontend`, `display` |
| `apps/server` | Bun/Elysia + Effect: OPAQUE auth, devices, sessions, presence, push, installer, box hosts, STUN tickets, telemetry, libSQL, Redis | rules `effect`, `server-services` |
| `apps/daemon` | Bun CLI (`merkur --help`) and thin orchestration around the dataplane | rules `effect`, `ipc`, `speculative-echo` |
| `apps/daemon/dataplane` | Rust: PTY, WebTransport, peer auth, display encode/ACK/resync/FEC, input, heartbeat, NAT client | rules `dataplane`, `display`, `protocol` |
| `apps/edge` | Rust blind WebTransport relay; forwards sealed frames, registers replica/cert state | rule `edge` |
| `apps/stun` | Rust ticketed STUN responder; every rejection is silence | rule `stun-ticket` |
| `packages/config` | Effect config loading, validation, retry schedules | rule `server-config` |
| `packages/logger` | Structured JSON logging + Effect logger | `docs/observability.md` |
| `packages/auth` | OPAQUE helpers, HMAC-SHA-512 tokens, ML-DSA-87 session authorization | rule `crypto-bootstrap` |
| `packages/shared` | API contracts, signaling, transport (`TRANSPORT_CHANNEL_ID`), crypto, IPC framing, domain types | rules `protocol`, `ipc` |
| `packages/protocol` | TS encoders, input records; opcodes in `merkur-wire`, channel ids in `shared` | rule `protocol` |
| `packages/daemon-control-protocol` | Message shapes for the daemon WSS control link | rule `effect` |
| `packages/keyboard` | On-screen keyboard, layouts, touch model, offset learner | rule `keyboard` |
| `packages/term-wasm`, `merkur-codec`, `merkur-fec`, `merkur-graphics`, `merkur-image-worker` | Rust/WASM terminal, codec, FEC, graphics | rules `display`, `dataplane` |
| `packages/merkur-e2e`, `e2e-wasm` | One implementation of ML-KEM/Noise bootstrap, native and WASM | rule `crypto-bootstrap` |
| `packages/merkur-stun-protocol` | STUN wire codec and consent proofs shared by daemon and responder | rule `stun-ticket` |
| `packages/*-patch` | Vendored `[patch.crates-io]` crates (alacritty, vte, wtransport, quinn, quinn-proto, fontdue) | rule `vendored-crates` |
| `packages/zstd-fixture` | Native zstd block generator for browser display benchmarks | `docs/performance.md` |
| `scripts` | Gates, harnesses, benchmarks, agent hooks | skill `verify` |

## Docs And Rules Index

| Topic | Doc | Rule / skill |
| --- | --- | --- |
| Transport, NAT, direct path, edge | `docs/transport.md` | `protocol`, `edge` |
| Display encoding, ACK, presentation, compression | `docs/display-invariants.md` | `display` |
| Crypto, delegation, rebind, identity custody, speculative echo | `docs/security.md` | `crypto-bootstrap`, `daemon-identity`, `speculative-echo` |
| Process lifecycle, supervision, IPC | `docs/processes.md` | `ipc` |
| Hot-path design, benchmark methodology | `docs/performance.md` | `dataplane` |
| Where prose lives: `docs/` is undated reference; this tree holds no dated records, open-item lists or proposals | `docs/` | `check:docs` |
| Health, signals, metrics, exporters | `docs/observability.md` | `no-otel-sdk` |
| Releases, signing, rollout | `docs/releases.md` | skill `release` |

Read the area's doc before non-trivial work, and the recorded outcomes of earlier
experiments before a performance change, so one is not re-run.

## Finding Code

`codegraph_explore` (shell: `codegraph explore "<query>"`) comes before grep or Read. Ask
the question, name the symbols of a flow, or name a file; its source is safe to `Edit`
from, so never re-verify it with grep. Read only what it missed or its "edited since the
last index sync" banner lists. A hook denies grep/cat/sed over source and refuses the whole
command line, so search prose and config in separate commands. Never delegate a lookup. In
a worktree run `codegraph init .`, then pass its path as `projectPath`.

## Single Version, Hard Cutover

There is exactly one version of Merkur: the current checkout. No users in the field, no
older clients, no migration window.

- Change every side of a contract in the same commit (browser, server, daemon, Rust
  dataplane, WASM, protocol, config, persisted schemas, tests) and delete the old path.
  Protocol, IPC, and persisted-config changes are hard cutovers; linked daemons,
  installed PWAs, service workers, and stored configs are re-linked or wiped, never read
  in their old shape.
- No versioning: no protocol version fields, capability negotiation, rollout flags,
  schema version columns, `v2` names, or version-gated branches. A build identifier stays
  informational; never branch on it.
- No compatibility gates: no shims, dual-read/dual-write, deprecation periods,
  old-to-new adapters, optional-field bridges, or "keep the old handler for now".
- Infrastructure too: obsolete volumes, env vars and units go once the cutover works;
  confirm destructive production deletes first.

## Working Principles

- **Build the best design.** Rewrites and cross-cutting refactors are in scope for the
  requested work. Never offer a cheaper subset, a prototype, or "a follow-up" instead.
- **Hyper-performance is the goal.** Minimize latency, allocations, copies, round trips,
  and main-thread or hot-path work, even when it takes more code. Steady-state cost
  outranks one-time cost.
- **Minimum code is not minimum effort.** No speculative features, single-use abstractions,
  or unrequested configurability.
- **One final solution.** No fallback paths, dual behaviour, or ambiguous paths in shipped
  code. If a fallback appears necessary, stop and ask.
- **Deterministic over heuristic.** Find the real signal (a lock, event, generated fact),
  whatever it costs, or drop the feature. Thresholds, caps, TTLs, probes, regex
  guesses and proxy events cannot substitute for it.
- **Explore before ruling out.** Research compares alternatives in isolated, budgeted
  experiments, each with a hypothesis and a stop condition. Distinguish impossibility,
  implementation limits, measured failure, and policy; read the engine, library or spec
  source before calling something impossible. Timeouts prove only that attempt failed.
  Shipping requires real success signals, including authenticated peers. Before removing
  a mechanism, find what introduced it.
- **Finish the cutover**, including the prose that describes it (Close The Loop below).
- Terminal data, display ACKs, session token validation and daemon challenge/response
  stay in the Rust dataplane unless explicitly requested.
- Match existing style even if a different abstraction looks cleaner. Clean up only what
  your own change caused; do not remove unrelated dead code or reformat unrelated files.
  Do not remove apparently unused exports or files unless the task is about dead code;
  `check:dead` and `check:ratchet` enforce reachability.

## Effect, Briefly

The repo is on Effect 4; recalled APIs are usually Effect 3 or a release candidate and fail
`check:types`, so read `node_modules/effect/src`. The `effect` rule carries the coding
rules and settled divergences. Browser hot-path modules (enforced by
`scripts/check-latency-boundaries.ts`) and the Rust dataplane never use Effect.

## Style

Strict TypeScript with `noUncheckedIndexedAccess` and `useUnknownInCatchVariables`, Bun
APIs, and the `tsconfig.base.json` path aliases. Biome: 2-space indent, single quotes,
semicolons, trailing commas, 100 columns; it **errors** on `console` and on non-null
assertions. Use `createLogger`, and narrow with explicit guards instead of `!`. Rust is
edition 2024 on the pinned toolchain (unset an ambient `RUSTUP_TOOLCHAIN`); never
`cargo fmt` a crate, `rustfmt` only the files you changed.

## Running The Stack

`bun install`, `bun run infra:up`, `bun run setup`, then `bun run dev` (edge + watched
server + Vite), `dev:server`, or `dev:full` (adds the linked daemon; needs
`~/.merkur/config.json`, and `merkur stop` leaves macOS without a daemon until
`merkur start`). `bun run dev:doctor` names the fix for each failure. Run scripts from the
repo root with `bun run --cwd <dir> <script>`, never `cd <package> && bunx`.

## Verification

`bun run gates` selects exact tests (changed tests, owning suites, workspace consumers);
`--run` executes them, skipping tests already green for the bytes they read, so a re-run
costs seconds. Do not chase failures provably outside the change.
The nine static gates are cheap and always run:

```
bun run check:types && bun run check:lint && bun run check:latency-boundaries && bun run check:span-lifetimes && bun run check:span-attributes && bun run check:dead && bun run check:ratchet && bun run check:slop && bun run check:docs
```

Then `bun run gates` prints the batched commands your diff implicates (`--all` adds the
minutes-long suites); the `verify` skill explains its table, batching, warm costs, and
what the cheap gates cannot prove.
`check:protocol` then `test:e2e:transport` gate every protocol, channel-ID, IPC, framing,
or crypto change; `check` and `test:unit` can both pass while sessions are broken.

- Prose and licence changes need only `check:docs`; questions and analyses run no gates.
- "Skip verification" skips `gates --run` and e2e for that request; the static gates
  (seconds) still run. Report what was skipped.
- A static gate red on committed `main` that you can fix in minutes, fix; one red from
  another session's uncommitted work, name once.

## Close The Loop

Prose is part of the cutover: run `check:docs`, then
`bun run scripts/doc-drift.ts --since <base>`, then re-read the area's docs (the
`close-the-loop` skill). Reference
docs and READMEs state the current system only: no migration history or provenance.
Dated results, open items and unbuilt designs are never written into this tree. A doc that
contradicts the code is a bug: say so.

## Sessions, Commits, Reports

Sessions share this checkout. Main pushes run CI; only a tag releases and deploys the app.

- Stage owned paths explicitly; read the staged diff. Never `git add -A`/`.`,
  `commit -a`, `--amend`, pathless `stash`/`reset`, or checkout/rebase over others' work.
- Verified implementation work is committed to `main` and pushed without asking. Include
  other sessions' files only when told to; if "everything" is ambiguous, ask once.
- Scratch, handoffs and exported transcripts stay out of the repo. Credentials come from
  the macOS Keychain or a CLI login, never chat.
- Decide engineering choices; ask only when scope, access, approval or a destructive
  action blocks you. Never end a turn announcing work you have not done.
- A fix is verified once the failure reproduced, then vanished, on the reporter's engine
  and device (owner: Zen/Gecko on macOS, iPhone PWA; Europe/Madrid time); else state the
  gap. Check UI in screenshots, name what a fix could regress, and after a user-visible
  release sign in and open a session.
- Reports open with the answer (fixed? net positive on one harness?) and close with state:
  sha, pushed, released, gates run or skipped, what is left.
