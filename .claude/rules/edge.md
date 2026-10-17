---
paths:
  - "apps/edge/**"
---

# Edge relay

The edge relays sealed frames without inspecting their channel or body. Keep it that way:
channel and payload changes must not require an edge change. Only splice registration,
session-handshake, splice-lifecycle, and cert-registration changes touch `apps/edge`.

The splice registry is per-process and in-memory by design, so a rebind only works if a
returning browser reaches the same edge process. Scale the edge by adding replicas with
distinct dedicated addresses, never two behind one address; that would break rebind
silently. A replica is one host in `deploy/service-hosts.json`, whose edge public URL may be
a DNS name — the browser pins the certificate hash, not the name — pointing at that host's
own address. `scripts/service-hosts.ts` renders each host's environment and release version
into the files `apps/edge/merkur-edge.service` reads; the release installs Bazel's release
binary, built from the workspace so the vendored `[patch.crates-io]` crates reach
production. Gate: `rust:lint`, then
`cargo test -p merkur-edge`; rebind changes also need `test:e2e:rebind`.

`splice.rs` forwards every frame and denies the timer calls `clippy.toml` lists: forwarding
waits on the event itself, and `rust:lint` fails a new timer there. The registry's expiry
worker in the same file is the one expected call.
