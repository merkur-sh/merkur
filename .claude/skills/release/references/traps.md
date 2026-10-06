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
- Review [CI operations](../../../../docs/ci.md) for setup, recovery and the retained journal.
