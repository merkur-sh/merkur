---
paths:
  - "package.json"
  - "apps/*/package.json"
  - "packages/*/package.json"
---

# Dependencies

`check:audit` runs with no `--ignore`, and the root `package.json` overrides two packages
only: `seroval` and `seroval-plugins`, because `solid-js` and `@solidjs/web` 2.0.0-rc.1
pin `~1.5.4`, a line with open advisories; the override goes when Solid moves to a release
that depends on 1.6. An ignore list and a wider `overrides` block once cleared advisories
dragged in by `@elysiajs/opentelemetry`'s `@opentelemetry/sdk-node` pin; that package is
gone, along with every `@opentelemetry/*` dependency. Do not reintroduce an OpenTelemetry
SDK: traces, logs and metrics all go through `effect/unstable/observability`, and
`docs/observability.md` explains why the SDK's global context was the fault behind three
trace-corruption incidents. `check:audit` fails on any severity; do not widen it with
`--audit-level`. Run `bun add` from the repo root (`--cwd <dir>` for a package), never from
inside a workspace package.
