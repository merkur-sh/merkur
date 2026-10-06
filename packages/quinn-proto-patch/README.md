# Merkur quinn-proto patch

Merkur's pinned copy of [`quinn-proto`](https://crates.io/crates/quinn-proto) 0.11.17,
applied through the root workspace's `[patch.crates-io]`. **This is a modified copy of
quinn-proto, not upstream quinn-proto**, and it is redistributed under upstream's terms:
MIT or Apache-2.0, whose texts are the `LICENSE-MIT` and `LICENSE-APACHE` files beside
this README.

## Merkur's changes

- Every queued datagram entry is charged exactly, payload and entry metadata together, so
  an admission that cannot fit is refused instead of evicting a datagram the connection
  already accepted. `packages/quinn-patch` admits an immutable `Bytes` payload and a
  separate application varint prefix against that accounting without copying an envelope.
- `PathStats` exposes the congestion controller's exact bytes in flight and the pacer
  rate. Merkur's display planner consumes those values with RTT, loss, MTU and
  send-buffer occupancy rather than inferring delivery from an application bitrate.

## Moving it

This crate is deliberately not a workspace member; the comment above `[patch.crates-io]`
in the root `Cargo.toml` explains why. Move it with `packages/quinn-patch`,
`packages/wtransport-patch`, `apps/edge`, `apps/daemon/dataplane` and the root lockfile.
