# Release failure interpretation

- A green unit run does not prove a terminal connection. The release workflow requires the
  integration gates; `bun run ci:canary <device>` proves a real session after a release.
- A successful main candidate build is unsigned and does not deploy. The version tag is
  the release trigger; its commit must have successful main-push CI.
- A rejected signing/deployment environment can mean it still permits only main. Both
  release environments use selected `v*` **tag** policies, paired with immutable tag rules.
- A sequence reservation is consumed even if no release was published. Before retention,
  retry with a new tag; after retention, rerun the original run and reuse the retained bytes.
- Do not regenerate signatures to repair an expired release. A new sequence and version are
  required. Deleting a draft release does not erase the journal or release a sequence.
- A Railway success must refer to the deployment ID returned by that upload, then match the
  retained server/client signatures. A health response or commit label alone is insufficient.
- A canary identity invalidated by a schema hard cut must be relinked through its owner-authorized
  procedure. CI cannot manufacture an account owner's binding signature.
- Hosted macOS executable smoke tests do not prove physical Secure Enclave availability.
- A protocol, presence or telemetry change is a hard cutover: a daemon that has not updated
  breaks against the new server the moment it deploys. Prove the server on one updated
  daemon before reading a daemon that looks down as a release failure.
- A session stuck at the first-frame stage, with signaling, auth and shell startup all
  succeeding, is what a stale daemon looks like after a codec version change: the browser
  drops every frame as `InvalidVersion` (`packages/merkur-codec/src/decode.rs`). Compare the
  codec version at the tag with the daemon's before blaming transport.
- `daemon_perf_report_rejected` with status 400 in a daemon's log means its report no
  longer matches the deployed server's schema: a half-rolled telemetry cutover. It posts every
  60 s, so it is the quickest post-release signal. A 503 on the same path is Railway's edge,
  not the release.
- Another session can commit or unstage in the shared checkout mid-release. Re-read
  `git log` and `git status` immediately before tagging, not the opening snapshot.
- A local `check:types` error naming a `term-wasm` export, or a WASM provenance failure, is the
  gitignored `pkg/` from an earlier build, never a deployment signal: `bun run build:wasm &&
  bun run sync:wasm`.
- Review [CI operations](../../../../docs/ci.md) for setup, recovery and the retained journal.
