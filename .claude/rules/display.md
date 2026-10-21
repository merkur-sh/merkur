---
paths:
  - "apps/daemon/dataplane/src/display/**"
  - "apps/web/src/terminal/**"
  - "apps/web/src/transport/browser-client-session.ts"
  - "apps/web/src/terminal-worker.ts"
  - "packages/term-wasm/**"
  - "packages/merkur-codec/**"
---

# Display path

Read `docs/display-invariants.md` before changing anything here; it is the contract, and
each rule records what broke without it. Tread carefully around per-peer display caches,
row hash baselines, `sent_datagrams`, ACK handling, resync, FEC, and transport path
health. The one-line versions:

- The authoritative grid is the daemon's; the browser is synchronized by snapshots, row
  deltas, ACKs, resync, and FEC. ACKs advance rows from the exact sent snapshots.
- A display datagram is a complete, order-independent, idempotent transformation; the
  datagram lane never carries a multi-chunk frame; a delta naming other dimensions is
  refused (`display_dimensions_mismatch`), never fitted.
- Presentation grouping is advisory and browser-only; `END` alone never releases; a
  coherent transaction commits at a worker animation frame unless a met closure claim or
  the paced close releases it inside the task; there is no timer on the release path.
- The daemon never coalesces against a clock; damage is not an emit reason; write
  completions are confirmed before the read that echoes them is applied.
- The ACK is a selective 128-bit bitmap; loss is declared after `LOSS_PACKET_THRESHOLD`
  actually applied successors, never from sequence distance.
- A flush is bounded by the carrier's measured free datagram-buffer space, never a byte
  constant, with no inter-group pacing.
- MZ is the one payload codec: a frame it would not shrink travels raw. Every context adapts
  within its frame from a prior: the static model compiled into both ends, or a session epoch
  both ends fold from acknowledged frames' symbol traces; a retrained model regenerates the
  browser calibration fixtures and test grids (`packages/display-fixture`). An epoch is used
  only after a datagram declaring it is acknowledged, and a browser refuses a declaration it
  cannot build. Copies name item runs of an earlier entry of the frame or of a complete row of
  an acknowledged datagram, which the browser kept as the frame carried it: of the frame's
  display generation (counted from the presentation id) or the one before (by sequence; a
  snapshot is datagram 0). Both ends run the same `MzGenerations`, the daemon's over a superset,
  so it never names a retired row. Rows and epochs survive generations and resizes; traces and
  declarations are a generation's. An unresolvable copy or epoch is a lost datagram, never a
  resync, and the browser reports its count in every display ACK.
- One wrap bit per row on the row's final cell; `row_hash` digests it.
