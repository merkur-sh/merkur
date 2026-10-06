# Dependency audit execution

`dependency_audit_capture` is a run executable for fresh external acquisition. It copies
the declared Bun lockfile, package manifests and Cargo lockfile into a private workspace,
uses a fresh empty home, and runs the original pinned Bun 1.4.2 audit followed by
cargo-audit 0.22.2 with `--deny yanked` for every declared Cargo lockfile. Cargo does not run
when the Bun audit fails; a Cargo failure short-circuits the remaining lockfile contexts.
No package installation, Cargo dependency resolution, ambient executable or user
configuration participates. Original Bun JSON, Cargo terminal output, diagnostics and
process status are retained in the acquisition snapshot.

The controller invokes its configured capture target with a fresh acquisition request
File and a new snapshot output path:

```
--request /absolute/controller-request --snapshot /absolute/new-audit-snapshot.json
```

`dependency_audit_test` consumes that snapshot and the same request as declared Files. It
binds the exact source inputs, native engine identities and complete runtime/configured
dependency closure. A changed request, lockfile, tool, runtime member or configured graph
invalidates the snapshot. Original failures remain failures. Missing Cargo coverage,
policy exemptions, incomplete Bun reports and reported yanked-index acquisition errors
are refused.

Cargo runs in its original terminal output mode because its JSON mode suppresses
yanked-index fetch/open warnings. A nominal zero status accompanied by those exact
upstream failure signals cannot satisfy the audit.

Both targets require explicit `bun`, `cargo_audit`, `sdk`, `inputs` and
`configured_inputs` dependencies. `sdk` must expose the existing `NativeSdkInfo` provider;
the native tool executables and their complete runfiles are declared. `inputs` maps source
File labels to their workspace-relative names and requires `package.json`, `bun.lock` and
the five Cargo locks: `Cargo.lock`, `tools/bolero/Cargo.lock`,
`tools/ownership-proofs/Cargo.lock`, `tools/edge-kernel-profile/Cargo.lock` and
`tools/sim/Cargo.lock`. Each lock must retain its exact original File path and owner.
Workspace package manifests and existing audit configuration belong in the same mapping. `configured_inputs` binds
the generated application dependency closures; their independent parity controls remain
required by the verification controller.

The capture executable performs network work outside immutable Bazel execution. The test
does not contact registries or advisory services. Current external evidence requires a
new controller request and a fresh capture; a cached old snapshot is insufficient. The
controller admits the audit only after both acquisition and the configured snapshot test
succeed. Bazel modules, downloaded tools and executor images remain in their respective
supply-chain controls; an application lockfile audit does not certify them.
