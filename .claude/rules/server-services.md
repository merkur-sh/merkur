---
paths:
  - "apps/server/src/**"
---

# Server services and HTTP contracts

Start at `apps/server/src/runtime.ts`: it composes the service layers, creates
`serverRuntime`, and exposes `runServerProgram`. Services use `Context.Service` tags plus
`Layer.effect` (`AuthServiceTag`, `DeviceServiceTag`, `RedisServiceTag`,
`RealtimeCoordinationServiceTag`). Route handlers run their programs through
`runRouteEffect` / `runLoggedEffect` from `apps/server/src/http/effect-route.ts`.

Wrap Kysely and Redis at the boundary with `Effect.tryPromise` and normalize into project
error types. Transactions use `withDatabaseTransaction`, which already handles commit,
rollback, and re-failing the original cause. Scope long-lived resources with
`Effect.scoped`, `acquireRelease`, `Layer.effect`, `forkScoped`.

## Adding or changing a service

Define the interface and `Context.Service` tag in `apps/server/src/services`; implement
`Layer.effect(Tag, Effect.gen(...))`; acquire dependencies by `yield*`-ing their tags
(`ServerConfigService`, `DatabaseService`, `RedisServiceTag`, …); wrap database, Redis,
filesystem, crypto, process, and network boundaries in Effect constructors with normalized
errors; add the layer to `apps/server/src/runtime.ts` and update `ServerRuntimeContext`;
then use it from route Effects, mapping domain errors with `runRouteEffect`.

`SessionServiceTag` owns session requests, capability renewal, cancellation and revocation.
Session routes provide the authenticated account/delegation and resolved browser IP; they do not
resolve lower-level coordination, signing, edge-selection or issuance dependencies themselves.
Issuance contracts, persisted-state codec and Redis lease/CAS operations are separate from the
issuance state machine. Validate the linked identity before predecessor retirement and validate
the exact response identity before durable preparation or replay.

Keep services free of Elysia request/response objects. Route handlers own HTTP shape,
authentication middleware, status codes, and response schemas.

## HTTP and API contracts

- Elysia route plugins live under `apps/server/src/http/routes`. Use
  `authenticatedApiPlugin` and `authorizeRequest` rather than reimplementing bearer-token
  parsing, and prefer existing `ApiModels` / `@merkur/shared` schemas. A response the
  browser parses has its schema in `packages/shared/src/api-schema.ts`, written in the
  subset `schema-check.ts` accepts, and its route declares it as `response:`.
- Elysia 2 routes take `(path, options, handler)`. Lifecycle scopes are strings;
  `plugin` is the enclosing-plugin scope. Browser authorization runs in `transform`
  before validation; `derive` runs after validation. Keep the shared error plugin
  ahead of route registration and expose only schema-authored validation details.
- WebSocket `derive` runs once during upgrade; `beforeHandle` also runs on messages.
  Keep connection admission and upgrade rate limits in `derive`.
- The server imports its validation bootstrap before any schema construction.
  Keep TypeBox's catalog pin: Elysia's selected beta depends on a compiler field
  removed after TypeBox 1.3.23. A standalone executable test covers the bootstrap.
- Keep Eden `treaty<App>` imports type-oriented; data crossing a network boundary still
  needs explicit runtime guards.
- Response contracts are free to change. When changing one, update server schemas, shared
  validators, web callers, daemon callers, and tests in the same commit.
- Redis-backed services keep both a fake-backed unit test and a `*.dragonfly.test.ts`;
  update the pair together.
