---
paths:
  - "package.json"
  - "apps/*/package.json"
  - "packages/*/package.json"
---

# Dependencies

`check:audit` runs with no `--ignore` and the root `package.json` has no `overrides`
block. Both existed to clear advisories dragged in by `@elysiajs/opentelemetry`'s
`@opentelemetry/sdk-node` pin; that package is gone, along with every `@opentelemetry/*`
dependency. Do not reintroduce an OpenTelemetry SDK: traces, logs and metrics all go
through `effect/unstable/observability`, and `docs/observability.md` explains why the
SDK's global context was the fault behind three trace-corruption incidents. `check:audit`
fails on any severity; do not widen it with `--audit-level`. Run `bun add` from the repo
root (`--cwd <dir>` for a package), never from inside a workspace package.
