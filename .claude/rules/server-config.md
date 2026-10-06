---
paths:
  - "packages/config/**"
  - "scripts/dev-setup.ts"
  - "scripts/dev-*.ts"
  - "scripts/build-web.ts"
  - "apps/server/.env.example"
---

# Server configuration

Config lives in `packages/config` using Effect `Config`/`ConfigProvider`, typed errors, and
`Layer` provisioning. Config tests use `ConfigProvider.fromUnknown` + `ConfigProvider.layer`
rather than mutating the process environment.

Declare every server variable in `packages/config/src/server-environment.ts`: its Effect
Config, required/secret metadata, operator notes, and template example. The loader consumes
those Config values. `bun run generate:docs` derives the README table and
`apps/server/.env.example` from the catalog; default and required metadata are checked by
evaluating the Config against an empty provider, never by scanning source text.

For a new required variable, update `scripts/dev-server-env.ts` to provision it locally.
Its tests validate fresh and existing candidates through the real loader. Setup preserves
existing assignments and identity, validates the persisted candidate independently of
external overrides, then writes atomically under an exclusive lock with mode `0600`.
Invalid existing configuration fails without replacing it.

Local tools resolve dotenv explicitly through `packages/config/src/environment.ts` with
literal process overrides. Keep credentials redacted in typed config until the IO or
crypto adapter needs them. Each child receives only its owned inputs; Vite receives the
public OPAQUE pin and its proxy target, and does not load dotenv itself. The immutable
web-build pin is supplied at the server composition boundary, independently of runtime
configuration overrides.
