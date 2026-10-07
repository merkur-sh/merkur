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
through `effect/observability`, and `docs/observability.md` explains why the
SDK's global context was the fault behind three trace-corruption incidents. `check:audit`
fails on any severity; do not widen it with `--audit-level`. Run `bun add` from the repo
root (`--cwd <dir>` for a package), never from inside a workspace package.

Solid is one release candidate across its packages. `apps/web` and `apps/site` pin
`solid-js`, `@solidjs/web` and the `@solidjs/vite-plugin` built for them exactly;
`@solidjs/signals`, `@solidjs/compiler` and `@solidjs/babel-plugin` arrive through caret
ranges, so `bun.lock` is what holds them at the same candidate. A resolution that starts without that lock entry
takes the newest candidate of each and mixes a runtime with another candidate's signals and
compiler. Move all of them in one change and read the lock afterwards: one version of
each, all the same candidate.
