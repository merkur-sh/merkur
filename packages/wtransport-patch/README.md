# Merkur wtransport patch

Merkur's pinned copy of [`wtransport`](https://crates.io/crates/wtransport) 0.7.2. The
root Cargo workspace overrides the registry crate through `[patch.crates-io]`, so
`apps/edge` and `apps/daemon/dataplane`, the two crates that run a WebTransport server,
compile against this exact source tree. It is redistributed under upstream's terms,
`MIT OR Apache-2.0`; `LICENSE-MIT` and `LICENSE-APACHE` beside this README are copied
from the upstream repository at tag `0.7.2`, because the published `.crate` archive ships
no licence files and both licences require the notice to travel with the code.

## Merkur's changes

The patch makes datagram sending non-dropping and exactly budgeted, and exposes QUIC
delivery state without taking Quinn's connection lock. It relies on the matching
`packages/quinn-patch` and `packages/quinn-proto-patch`.

| Where | Change |
| --- | --- |
| `Connection::send_datagram` (`src/driver/mod.rs`) | Polls Quinn's non-dropping send exactly once under the connection-state lock. A full queue returns `SendDatagramError::Backpressure` and keeps every older datagram; upstream evicted the oldest. |
| `Connection::send_datagram_owned` | Sends an immutable `Bytes` payload with the session's quarter-stream-ID prefix through `quinn::Connection::try_send_datagram_with_prefix`, so no envelope is copied. |
| `SendDatagramError` (`src/error.rs`) | Adds `Disabled` and `Backpressure`. |
| `Connection::datagram_send_buffer_space`, `datagram_additional_entry_overhead`, `datagram_batch_send_buffer_space` (`src/connection.rs`) | Report queue room in application-payload bytes, net of the HTTP/3 datagram header (`Datagram::header_size`) and Quinn's per-entry charge, for one datagram or a batch. |
| `Connection::delivery_state`, `Connection::is_closed` | Read Quinn's `DeliveryState` latch without the lock; datagram room is again net of this session's header. |
| Unidirectional stream driver (`src/driver/mod.rs`) | Classifies incoming unidirectional streams concurrently in a `JoinSet`, so a stream whose type header is incomplete does not hold up later streams. Bidirectional streams keep their admission order because they carry the ordered routing preface and control channels. |
| `Cargo.toml` | `[[example]]` and `[dev-dependencies]` are stripped so their dependency trees stay out of the root lock. |

Session acceptance is upstream's: `IncomingSessionFuture::new` (`src/endpoint.rs`) awaits
the completed QUIC handshake before starting the H3 driver and does not opt into
`Connecting::into_0rtt`. Nothing the server sends moves ahead of the handshake, and the
crate does not change TLS authentication or client early data. Merkur's own
authentication runs at the application layer over the established session.

## Why it is not a workspace member

`[patch.crates-io]` needs a path, not membership. A member is a resolution root, so cargo
resolves its default features instead of the ones its dependents ask for, which pulls
`aws-lc-rs`, `aws-lc-fips-sys` and `cmake` into the lock; this workspace is `ring`-only
and has no C toolchain. The root `Cargo.toml` comment above `[patch.crates-io]` records
the same rule for `quinn-patch` and `quinn-proto-patch`.

## Moving it

Move this crate, `packages/quinn-patch`, `packages/quinn-proto-patch`, `apps/edge`,
`apps/daemon/dataplane` and the root lockfile together or not at all.
`apps/edge/Dockerfile` builds from the repository root so this patch reaches production;
a standalone edge build would silently ship the registry crate.

## Validating

```bash
cargo build --release --locked -p merkur-edge -p merkur-dataplane
bun run check:protocol
bun run test:e2e:transport
```
