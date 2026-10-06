---
paths:
  - "packages/protocol/**"
  - "packages/shared/src/transport.ts"
  - "packages/shared/src/display-stream*.ts"
  - "packages/merkur-codec/**"
  - "packages/term-wasm/**"
  - "apps/daemon/dataplane/src/**"
  - "apps/web/src/transport/**"
  - "apps/web/src/terminal/**"
  - "apps/edge/src/**"
---

# Protocol and wire contracts

Protocol and persisted-config changes are hard cutovers: browser, TypeScript protocol,
Rust dataplane, and WASM move in the same commit, and existing linked daemons, installed
PWAs, service workers, and stored configs are re-linked, re-installed, or wiped rather
than supported. `check:protocol` is the gate for every protocol, channel-ID, framing, or
crypto change; `test:e2e:transport` is the only gate that exercises a real splice.

- Channel IDs are shared across browser, TypeScript protocol code, Rust dataplane, and
  WASM. They live in `packages/shared/src/transport.ts` (`TRANSPORT_CHANNEL_ID`). Message
  type numbers live in `merkur_wire::protocol` (`MSG_TYPE_*`); `packages/protocol` mirrors
  only the `MESSAGE_TYPE_*` its TypeScript encoders and readers use, pinned by
  `wire-conformance.test.ts`. Update all sides together.
- `merkur_codec::VERSION` is the display wire version and is currently `32`. Bump it
  whenever the display stream **or** its control messages change shape: the envelope is
  byte-identical across compression changes, so version skew is the one corruption this
  stream cannot otherwise detect. `check:docs` pins this sentence to the constant.
- Browser input is input records (`input_record.rs` / `input-record.ts`), never PTY bytes:
  the dataplane encodes each record against the terminal's modes when it admits it
  (`pty/input_encoder.rs`). Keep the two codecs and their rejection vectors in step.
- Durable reliable lanes are persistent per channel: one channel-prefixed stream per carrier
  generation carrying length-prefixed records. Finite transfers use the prefix high bit,
  one bounded total length and FIN, and never rotate onto a successor destination.
- ML-DSA-87 capability/delegation/identity verification, ML-KEM, and Noise are
  connection-bootstrap work. They must never enter the per-frame input, display, ACK,
  FEC, or render path.
- Display rules are in `docs/display-invariants.md` (loaded through `display.md`).
