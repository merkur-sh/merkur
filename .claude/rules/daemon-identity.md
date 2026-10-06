---
paths:
  - "packages/merkur-identity-seal/**"
  - "apps/daemon/dataplane/src/identity_cli.rs"
  - "apps/daemon/dataplane/src/identity_signer.rs"
  - "apps/daemon/dataplane/src/auth.rs"
  - "apps/daemon/src/cli/identity-seal.ts"
  - "apps/daemon/src/cli/link.ts"
  - "apps/daemon/src/services/daemon-proof-signer.ts"
  - "packages/auth/src/daemon-proof*.ts"
  - "apps/server/src/http/daemon-request-auth.ts"
---

# Daemon identity custody

Daemon identity custody is one primitive, `KeyCustody`, pinned in `daemon_identity_seal`
(`hardware`, or explicitly selected `software`). The per-platform `Chip` (Secure Enclave,
TPM) implements five operations; the resident vs sealed-seed composition is written once in
`hardware.rs` and pinned in the material, never re-probed. Rust owns key generation,
unsealing and every signature; Bun requests management proof pairs over IPC 0x10/0x94.
Hardware calls run on a bounded blocking worker and never block the terminal owner loop.
Runtime failure exits 3 with no downgrade. Never hand a chip a corrupted key blob, even in a
test: CryptoKit traps and `ctkd` aborts on them, and enough aborts put every enclave call on
the Mac behind a 20-minute launchd penalty. Tamper tests stop at the material digest. Read
`docs/security.md` (Hardware-Bound Daemon Identity, Daemon Management Proofs) before changing
this contract. macOS builds compile the CryptoKit Swift bridge with the macOS 26 SDK
(Xcode 26).
