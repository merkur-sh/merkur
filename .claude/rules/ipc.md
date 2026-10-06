---
paths:
  - "apps/daemon/dataplane/src/ipc/**"
  - "apps/daemon/src/services/dataplane-client*.ts"
  - "packages/shared/src/ipc*.ts"
---

# Daemon IPC frames

If changing IPC frames, update both the Rust frame definitions and the TypeScript
dataplane client. The IPC structs are `snake_case` with `#[serde(deny_unknown_fields)]`
and no `rename_all`, so a TypeScript writer emitting a camelCase key does not produce a
slightly wrong payload: serde rejects the whole command and the feature is silently dead
while every TypeScript gate passes. Assert the exact key *set*, in
`packages/shared/src/ipc-wire-conformance.test.ts` and
`apps/daemon/src/services/dataplane-client.test.ts`. A change to the daemon's IPC surface
or its config is a protocol change even when nothing under `packages/protocol` moved: run
`check:protocol`, then `test:e2e:transport`.
