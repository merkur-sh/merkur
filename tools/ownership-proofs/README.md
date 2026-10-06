# Bounded ownership verification

This independent workspace generates proof inputs from the actual production Rust AST
in client `session.rs`, E2E `lib.rs`, and edge `splice.rs`. Its build script extracts the
writer-custody and lane predicates, routing types and implementations, and membership
methods into `OUT_DIR`. Each requested symbol must match exactly once; source changes
trigger regeneration. The proofs compile those generated bodies with test-only adapters
for synchronization, mailbox, watch and session behavior. No implementation is copied
by hand, and production source, visibility and compilation context remain unchanged.
Production continues to use parking_lot, Tokio and the real transport.

```sh
bun run setup:kani
bun run test:ownership
bun run test:ownership:kani
bun run test:ownership:negative
```

Use rustup's Cargo shim with the pinned production toolchain. `setup:kani`, which the
Bolero parser proofs share, pins kani-verifier 0.68.0 and installs its own matched verification toolchain. It does
not replace production Rust. Loom is locked to 0.7.2 in this separate workspace. A
separate CARGO_TARGET_DIR avoids contention with production builds.

Three Kani harnesses quantify arbitrary connection IDs and channel bytes within bounded
states with at most two active owners. They check writer custody across provider changes,
unblocked state with no owners and independent credit for other recognized lanes. This
is ownership of the shared counter lane; it is not a proof of Noise, AEAD nonce generation
or the entire counter implementation.

Five Loom models exercise source replacement racing route admission, destination
replacement, pair retirement, slot destruction with retained handles and stale detach
against a successor attachment. No preemption or iteration cap truncates these model
runs. The adapters do not prove parking_lot, Tokio or QUIC internals.

`negative_controls.py` changes temporary copies of the original production source;
the build script extracts each deliberately broken body. Provider-specific custody,
releasing the route guard before admission, omitted retirement, omitted slot cleanup
and omitted attachment-generation equality must each produce their expected invariant
failure. A compilation failure is not accepted as the negative-control result.

These are narrowly scoped exhaustive checks. Keep native integration tests and real
signed-session/rebind tests: they cover the actual transports and concrete dependencies
that the proof adapters abstract away.
