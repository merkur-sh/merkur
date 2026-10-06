# Parser and decompression campaigns

These five Bolero targets and the bounded proofs below compile the original production
source. `scripts/fuzz-tests.ts`
generates a separate Cargo workspace under ignored `test-results/bolero/workspace`,
resolves manifest-relative paths to the original checkout, preserves test assets with
symlinks and uses the retained `tools/bolero/Cargo.lock`. Bolero is never added to the
production workspace or its lockfile. Its generator currently pins indexmap to a version
different from production; independent resolution keeps that pin out of shipped crates.

Use Merkur's pinned Rust toolchain, with the rustup shims ahead of system Rust in PATH.
The runner removes ambient RUSTUP_TOOLCHAIN and encoded flags. Instrumented campaigns
use cargo-bolero's scoped rustc-bootstrap option; no production toolchain changes.

```sh
bun run setup:fuzz
bun run test:fuzz:instrumentation
bun run test:fuzz:smoke
bun run test:fuzz:campaign 10000
bun run scripts/fuzz-tests.ts policy
```

`setup:fuzz` pins cargo-bolero 0.13.5; the generated dev dependency pins Bolero 0.13.6.
Smoke directly checks valid encoder seeds and replays random seed 1 without additional
random seeds. Campaigns write those same encoder outputs to each target's corpus before
starting libFuzzer, including complete plain/compressed display frames, a valid compressed
payload, wire handshakes and input runs, and authenticated STUN requests and responses.
Campaigns use libFuzzer, seed 1, a finite execution budget, 4 KiB maximum input,
a two-second per-input timeout and a
2 GiB engine RSS limit. Each target runs sequentially with one engine worker. A compile
sentinel, checked by a removed-instrumentation negative control, refuses a campaign whose
libFuzzer cfg disappeared; encoded Cargo flags would otherwise silently override
cargo-bolero's instrumentation flags.
`test:fuzz:instrumentation` compiles the actual shared sentinel in an isolated,
dependency-free Cargo workspace: engine flags pass and an encoded-flags override fails
with the intended diagnostic.

| Target | Boundary and invariant |
| --- | --- |
| `fuzz_wire` | Canonical framing, exact lengths, handshake and input-run parsing, input-record validation agreement. |
| `fuzz_stun` | Both network parsers, real authenticated encoder output, wrong-key and modified-request rejection, response integrity. |
| `fuzz_display_ingress` | Untrusted staged display frames cannot change authoritative terminal state before apply; released slots and budgets recover. |
| `fuzz_display_zstd` | Real compressed ingress enforces exact single-frame decompression and output shape, preserves authority on rejection and releases staging ownership. |
| `fuzz_display_roundtrip` | Compressed and plain valid display frames produce equal authority, including duplicate application. |

Valid encoder seeds exercise deeper paths directly and initialize the mutation corpus.
The input limit is an explicit campaign scope; it does not cover all production maximum-size messages,
all allocation failures or the complete protocol. Display tests use the production native
implementation and do not prove browser-specific WASM host behavior. Existing native,
WASM and authenticated transport gates remain required.

Corpus and crash inputs persist separately under `test-results/bolero/corpus/<test-path>` and
`test-results/bolero/crashes/<test-path>`. Rust namespace segments form nested directory
components, giving uploaded paths portable names. Repeated campaigns reuse the corpus;
CI retains both as artifacts. A crash fails the run and its input must be retained and
replayed before claiming a fix. To replay a specific retained input, use the generated workspace and
cargo-bolero's documented engine arguments; keep the same source and retained lock.

After an intentional production dependency change, run `test:fuzz:update-lock`, review
the tool lockfile diff and rerun source/license/backend policy plus smoke and campaigns.
The command updates workspace members, preserving compatible locked transitive versions.
The production lockfile is never written by this runner.

## Bounded proofs

The `proof_*` harnesses run one closure under two engines. `cargo test` (and
`test:fuzz:smoke`, at 10,000 random inputs each) draws inputs through Bolero's random
engine. Under `cfg(kani)`, `bounded.rs` hands the closure exactly `N` symbolic bytes and a
symbolic length, and Kani checks every input up to `N`, or every event sequence up to its
length; Bolero's own Kani engine always builds a 256-byte symbolic buffer, which kept even
6-byte proofs from finishing. `targets.json` lists the harnesses Kani proves; the others
run only under the random engine.

```sh
bun run setup:kani
bun run test:fuzz:kani                # every proof in targets.json
bun run test:fuzz:kani proof_proto_frame
```

`setup:kani` pins kani-verifier 0.68.0, shared with `tools/ownership-proofs`. The runner
gives each proof Kani's own 25-minute `--harness-timeout`, fails a refuted property, a
timeout, a changed generated lock, and any `kani::cover!` it cannot satisfy: an
unreachable cover means the proof checked nothing. A proof without a verdict in the budget
has its bound halved once and is otherwise left to fuzzing; its header comment records it.
The times in the tables below are an Apple-silicon laptop's; GitHub's hosted x64 runner
takes about half as long again, and the budget is sized for it.

Kani-proven, with the bound and the time the proof took on an M-series Mac:

| Proof | Bound | Property |
| --- | --- | --- |
| `proof_proto_frame` | 24 B, 8 s | An accepted frame is exactly its declared length, re-encodes to itself, and has no accepted prefix. |
| `proof_data_handshake` | 20 B, 1 s | A data handshake has one spelling. |
| `proof_frame_header` | 74 B, 11 s | Every display-header read is inside the checked length, and each in-place patch offset names the parser's bytes. |
| `proof_input_mapping` | all `u32`, 4 s | A wire sequence maps to a local one only inside the proven interval, never to zero, and injectively. |
| `proof_input_serial_order` | all `u32`, 3 s | A high-water never moves back, no two sequences advance on each other, and epochs advance exactly when sequences do. |

A proof can live in its crate under `cfg(kani)` when it needs the crate's private state; a
`targets.json` entry without `source` names it. `proof_rebind_keeper_chain`
(`packages/merkur-e2e/src/rebind_keeper/proofs.rs`) stubs every outcome the rebind keeper
does not decide itself: a MAC verifies exactly when the harness passed the valid tag, the
reconciliation attempt is the bytes the harness put in the request, and the KEM, the Noise
binding, the transcript and the digests are symbolic. zeroize's `optimization_barrier`, an
empty `asm!`, is stubbed out because Kani models no assembly. The generated workspace links
`packages/shared` beside its members, since `merkur-e2e`'s tests read
`../shared/test-vectors`.

| State-machine proof | Bound | Property |
| --- | --- | --- |
| `proof_rebind_keeper_chain` | 2 operations from any reachable state, 756 s | The generation never moves back and a successor is exactly one ahead; a successor leaves once, by promotion or drop, and only a promotion replaces the incumbent secret; an unproven, stale or other-attempt answer changes nothing; an unverified response leaves the one-use bootstrap. Secrets and attempts are symbolic in their first and last byte only, which the keeper cannot tell from fully symbolic ones because it never reads their bytes; fully symbolic, neither three operations nor two reached a verdict in 15 minutes, most of it unrolling wipes and whole-array comparisons. With `reconcile`'s MAC check removed, Kani refutes "only a proven answer settles". |

Random-engine only, because Kani reached no verdict within the budget:

| Harness | Property | Kani |
| --- | --- | --- |
| `proof_input_run` | An accepted run holds exactly `count` valid records and re-encodes to itself. | No verdict at 24 or 13 bytes. |
| `proof_heartbeat_ladder` | One escalation and at most one failure per ladder, a failure only after the link carried a probe, no timer left due, and the RTO within its floor and ceiling. | No verdict at six events, nor at three with or without round-trip samples. |
| `proof_input_record_canonical` | Every accepted input record is the spelling `build` (and the browser's `encodeKeyRecordInto`) writes for it. | No verdict at 12, 6 or 4 bytes. `proof_input_records_up_to_three_bytes` proves it by enumeration for every record of up to three bytes; that enumeration found the two non-canonical key-text spellings `8684a6ad` refused. |

Record text is what costs the solver: std validates UTF-8 a word at a time, and a byte-wise
model stubbed in its place did not bring either record proof inside the budget. The STUN
parsers need 60 and 68 bytes for their shortest accepted messages and got no verdict at
64 and 72, so they stay with `fuzz_stun`'s encoder seeds. Code Kani cannot reason about at
all stays with fuzzing and unit tests too: ring's HMAC (assembly), C zstd, and
`merkur-fec`, whose every path runs NEON, SSSE3 or simd128 intrinsics.
