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
- zstd: the C library on both ends, compiled to wasm32 for `term-wasm` and decoded
  one-shot, exactly one magicless frame (no content size, no checksum) per payload; the
  payload is the rows' stream-split layout (`merkur_codec::RowSplitter`), joined back
  before the one row validator reads it; level and dictionary cap
  are measured knees recorded in `compressor.rs`; dictionaries are the screen split as
  frames carry it, finalized, and installed READY → INSTALL → ACK, and the daemon never
  compresses against one before the ACK.
- One wrap bit per row on the row's final cell; `row_hash` digests it.
