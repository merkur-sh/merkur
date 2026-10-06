---
name: release
description: Release Merkur through protected version tags; CI builds, signs, deploys services and publishes the daemon release. Use when asked to cut a release, ship a version, or roll pending work to production.
---

# Releasing Merkur

Read `docs/releases.md` for artifact trust and `docs/ci.md` for setup and recovery.
The single production path is `.github/workflows/release.yml`: pushing an immutable
`vMAJOR.MINOR.PATCH` tag authorizes all stages. Main pushes check and build candidates.
There is no workstation build/signing handoff and no personal-computer rollout.

Before tagging, inspect the shared working tree and recent commits. Preserve other sessions'
changes. Run the verify skill's required checks, update implicated prose through
close-the-loop, commit only the authorized release changes, and push main. Wait for the
exact commit's successful main-push CI run. Do not guess a sequence: CI reserves it in the
append-only Git history of the `release-state` branch. A run whose jobs never start ("recent
account payments have failed") is GitHub billing: stop and tell the owner; there is no
workstation release path to switch to.

Once the user has authorized shipping that version:

```sh
.claude/skills/release/scripts/release.sh trigger vMAJOR.MINOR.PATCH
.claude/skills/release/scripts/release.sh watch vMAJOR.MINOR.PATCH
```

Use a real numeric version in place of the placeholder. Tagging is the release decision;
there is no second confirmation between CI stages. The existing release seed lives only in
the protected signing environment, with an offline backup. Never print, copy into the
checkout, or pass it to Railway. Do not change the trusted public pin.

CI deploys and proves Railway, edge and STUN before publishing daemon assets, then verifies
the public downloads. Daemons are not rolled by this workflow: personal computers update
under their owners' control, and a deployment that hosts daemons of its own rolls them from
the published release and proves a terminal session with `bun run ci:canary <device>`.

If a run fails before signed retention, consume that reservation and use a new version tag
after fixing the failure. If retained bytes exist, rerun the original workflow run and let it
restore those exact artifacts; never rebuild/re-sign a consumed sequence, refresh its expiry,
move a tag or roll back below a consumed floor. Expired retained releases require a forward
release. See `references/traps.md` before interpreting failures.

One-time provisioning is explicit in `docs/ci.md`: tag/environment protection, signing and
provider secrets and durable release state. Do not claim automation is active merely because
workflow files exist.
