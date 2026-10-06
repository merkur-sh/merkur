---
paths:
  - "apps/server/**"
  - "apps/daemon/src/**"
  - "packages/config/**"
  - "packages/logger/**"
  - "packages/auth/**"
  - "packages/shared/**"
  - "packages/daemon-control-protocol/**"
  - "apps/web/src/hooks/**"
  - "apps/web/src/screens/**"
  - "apps/web/src/lib/**"
  - "apps/web/src/session/**"
  - "apps/web/src/api.ts"
  - "scripts/bench-daemon-update-download.ts"
  - "scripts/ci-release-verify*.ts"
  - "scripts/dev-doctor.ts"
  - "scripts/dev-setup.ts"
  - "scripts/test-preload.ts"
---

# Effect 4 in Merkur

This repo is on Effect 4, the merged `effect-smol` codebase: http, sql, rpc, schema,
observability, and reactivity all live inside `effect/unstable/*` (no `platform` subtree,
only a top-level `PlatformError`), and much of the Effect 3 core API was renamed or
removed. It leans hardest on `effect/unstable/reactivity`: Atom and `AtomRegistry` come
from there, not from an `@effect/atom` package. Nearly every Effect answer on the web, and
nearly every remembered API, is Effect 3 and will fail `bun run check:types`. Treat any
recalled Effect API as unverified.

## Source of truth

**`node_modules/effect/src` is authoritative**: it ships full TypeScript source, so it
never goes stale against the lockfile. Search it before asserting an API exists. `LLMS.md`
at the root of `Effect-TS/effect` is the official agent guide, with topic guides in
`packages/effect/*.md` (`SCHEMA`, `CONFIG`, `HTTPAPI`); prefer an `AGENTS.md` in the
installed package if one ever appears, since it is version-matched. That repo's
`.patterns/` documents development *of* Effect, not consumer guidance. Do **not** consult
`~/.effect` or any other local clone; it tracks a different version and will confirm APIs
this repo does not have.

Two search habits: reserved-word exports are aliased at the end of a module, so
`grep "^export const catch"` finds nothing; look for `catch_`, `try_`, and the
`catch_ as catch` re-export block. And Effect 4 moved the unsafe marker from prefix to
suffix (`unsafeMake` → `makeUnsafe`), so retry a missing `unsafe*` with the suffix.

## Philosophy

Read Effect's model from `node_modules/effect/src`. Two consequences shape the rules below:
an Effect is a *description*, so `Effect.runPromise` inside a service silently discards
the error channel, breaks interruption, and escapes `TestClock`; and requirements flow up
while implementations flow down, which is why services never touch Elysia
request/response objects and why status codes live in route-local `mapError` functions.
Composition is the payoff; it is why `packages/config/src/retry-schedules.ts` holds one
reviewed backoff policy many call sites share. Prefer `Schedule` over loop counters,
`Effect.timeout` over racing a timer, `Match` over `if`-chains on tagged unions.

Style follows: `Effect.gen` plus `Effect.fn("name")`, behaviour attached by combinators
passed as extra arguments rather than `.pipe`-ing the result; no plain function that only
returns an `Effect.gen` (use `Effect.fn`, or `Effect.fnUntraced` where span overhead
matters); `Effect.catchTags` over chained single-tag catches; the `Predicate` module over
hand-rolled `isString`/`isRecord`; `DateTime`/`Clock` over `Date`/`Date.now()`.

## When not to use Effect

Effect's guarantees are not free, so Merkur spends them where correctness and lifecycle
dominate (auth, sessions, presence, config, retries, process lifecycle) and refuses them
where a frame budget binds. Browser hot-path modules must not import `effect` at all: the
enforced file list is `scripts/check-latency-boundaries.ts`, gated by
`check:latency-boundaries`. Per-keystroke input, display frames, ring drains, prediction,
and GPU submission are hand-written imperative code by design, as is the whole Rust
dataplane. A considered trade, not an area awaiting cleanup; do not Effect-ify those files.

That does *not* cover `apps/web/src/hooks`, `screens`, and `api.ts`: they are outside the
enforced boundary, so "hot path" is not a reason to keep Effect out of them. It is used
there for fiber lifecycle, streams, queues, schedules, latches, and scoped recovery state.
Preserve the device-list/Solid ownership split (see `frontend.md`) unless the task is
explicitly an architecture change.

The daemon uses Effect for process lifecycle, signals, scoped locks, retry loops, sleeps,
and CLI wrappers; keep it orchestration only.

## Deliberate divergences from official style (settled, do not "fix")

- **`Data.TaggedError`, not `Schema.TaggedError`**, across server, daemon, and packages.
- **`bun:test`, not `@effect/vitest`.** Effect tests run through `Effect.runPromise` at
  the test boundary, with `TestClock` from `effect/testing`.
- **Explicit type guards at untrusted boundaries, not `Schema` everywhere.** A response the
  browser reads is declared once, as a TypeBox schema in `@merkur/shared/api-schema`: the
  route names it in `ApiModels` and the browser reads it through `compileRequire`
  (`@merkur/shared/schema-check`, which names the failing path and keyword and never the
  value), never with TypeBox's own validator. Strings in that contract are `Text` (code
  points) or `Base64Url` (bytes); a request body that writes a stored field uses the same
  schema object as the responses that return it. Elsewhere, shared
  validators where they exist and hand-written guards otherwise.
- **Elysia for HTTP and Kysely over libSQL**, not `effect/unstable/http` or
  `@effect/sql-sqlite-bun`. Swapping either is a rewrite, not a cleanup.

Do not add `@effect/*` packages casually. Several still publish their Effect 3 build on
the `latest` npm tag, so a plain `bun add @effect/…` installs something incompatible with
the installed core; the Effect 4 builds sit behind the `beta` tag and move independently
of this repo's version. Check both the dist-tag and the resulting version against the
installed `effect` before adding one, and raise any skew rather than working around it.

## Coding rules

- Effects are values. Do not run them inside domain services with `Effect.runPromise`,
  `runSync`, or `runFork` unless you are at a real boundary: server startup,
  `runServerProgram`, CLI command wrappers, browser event/controller boundaries, or the
  logger implementation.
- Prefer `Effect.gen(function* () { ... })`. Terminate explicitly with
  `return yield* new MyTaggedError(...)`, or `return yield* Effect.fail(error)` for
  non-Data errors.
- `try`/`catch` inside `Effect.gen` catches nothing; Effect failures are not JS throws.
  Use `Effect.catch`, `catchTag`, `result`, or `exit`. Reserve `try`/`catch` for
  immediate non-Effect work such as `JSON.parse`; otherwise `Effect.try` / `tryPromise`.
- Normalize external thrown/rejected errors at the boundary into existing project types
  (`InfrastructureError`, `RedisError`, `ServerConfigError`, `DaemonConfigError`, or a
  domain-specific tagged error). Keep new service-level errors as `Data.TaggedError`;
  avoid stringly typed `Error` outside browser boundary code that already uses it.
- Map expected service errors to HTTP in route-specific mappers, never inside a reusable
  service. Catch broad errors only at logging, HTTP, CLI, or recovery boundaries.
- Use `Effect.ensuring` when mutable fiber handles or state must reset on success,
  failure, *and* interruption. Manual fibers need an owner, a `Fiber.Fiber` handle, and
  interruption from stop/cleanup paths.
- Prefer `Schedule` and duration strings (`"250 millis"`, `"5 seconds"`); shared retry
  policy lives in `packages/config/src/retry-schedules.ts`.
- Use `Option` for new internal Effect-domain absence. Preserve `null`/`undefined` at
  HTTP, JSON, Solid, IndexedDB, localStorage, Kysely, and public API boundaries.
- Avoid `as any`, `as never`, broad `as unknown`, and non-null assertions; narrow with
  explicit type guards.
- Observability boundaries use explicit Effect spans and project metrics. Keep the shared
  JSON logger installed even when OTLP is enabled, and read `docs/observability.md`
  before changing health states, signal formats, metric names, redaction, or exporter
  ownership.
