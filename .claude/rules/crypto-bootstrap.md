---
paths:
  - "packages/merkur-e2e/**"
  - "packages/e2e-wasm/**"
  - "packages/auth/**"
  - "apps/daemon/dataplane/src/session/**"
  - "apps/daemon/dataplane/src/auth.rs"
  - "apps/web/src/session/**"
---

# Session bootstrap, delegation, and carrier rebind

Read `docs/security.md` before touching any of this. There is exactly one implementation
of the crypto and wire format: `packages/merkur-e2e`, linked natively by the daemon and
compiled to WASM through `packages/e2e-wasm`, which seals and opens through per-session
buffers in linear memory rather than allocating per frame.

- Every edge signaling authentication starts with a fresh, one-use ML-KEM-1024 browser
  keypair and 32-byte nonce, authorized by a short-lived server ML-DSA-87 capability plus
  the browser's root-signed, fixed-30-day ML-DSA-87 delegation certificate and a delegate
  signature over the exact request transcript. The daemon matches that tuple against the
  authenticated control offer it already holds, verifies the user-root daemon binding and
  its local revocation tombstones, and signs the response with its permanent
  ML-DSA-87 + P-256 identity (both signatures are mandatory), binding the exact responder
  Noise message 2. HKDF-SHA-512 over the ML-KEM shared secret and signed response transcript
  derives the Noise PSK. Direct-upgrade and rebind secrets additionally bind a Rust-private
  Noise chaining-key checkpoint after message 2's `ee` and `es`, before `psk3`; the
  bootstrap type cannot expose those secrets until that binding completes. An in-session
  direct carrier reuses established Noise. There is no
  algorithm negotiation, fallback, or compatibility reader.
- A **carrier rebind** is the one reconnect that skips the server: the session combiner's
  64-byte chaining secret is the only secret allowed to authorize a successor without it.
  The incumbent Noise/direct generation stays usable while a successor is tentative; only
  a fully validated successor triggers the transactional key cut. Bounds live in
  `SessionPolicy` and are mirrored in `packages/config/src/reconnect-policy.ts`.
- Bootstrap crypto never enters the per-frame input, display, ACK, FEC, or render path.
- User root and browser delegations are browser-side; the server stores an OPAQUE
  registration record, never a password or hash.
