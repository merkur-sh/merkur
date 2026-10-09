# CI and release operations

What GitHub Actions runs for Merkur, what each workflow gates, how a release is cut, how a
failed release is recovered, and the one-time setup a repository needs before its first
release tag. The workflows live in `.github/workflows`; the release helpers they call live
in `scripts/ci`.

## What CI runs

[CI](../.github/workflows/ci.yml) is the branch-protection gate. It runs on every pull
request at its merge commit and on every push to `main` at the exact commit. It holds no
deployment secrets. Main, manual and release runs select every lane. PRs compare the checked-out
merge tree with the event's base commit, including deletions and both sides of renames.

The planner uses the local gate rules to omit native tests only for known TypeScript and CSS
paths with no native or protocol requirement. Product edits still select browser coverage;
ordinary unit-test-only edits do not. Prose-only PRs run documentation validation. Build scripts,
manifests, executable agent hooks, workflow changes and unknown paths select every lane. Every
selected lane runs its complete inventory; CI never reuses a cached test verdict.

`CI required` checks the exact job inventory against the plan. A selected job must succeed;
an omitted job must be skipped. Failed planning, missing outputs, cancellations and unexpected
skips fail the check. The workflow itself is never omitted by path filtering.

| Lane | What it proves |
| --- | --- |
| `wasm` | Builds and verifies WASM once, retaining the generated packages, hidden provenance files and the PGO build's native zstd fixture for consumers. |
| `browser-native` | Builds edge, proxy, dataplane and image worker in one Cargo invocation and retains the native artifact manifest. |
| `source` | Consumes verified WASM, runs the nine static gates (`check:types`, `check:lint`, `check:latency-boundaries`, `check:span-lifetimes`, `check:span-attributes`, `check:dead`, `check:ratchet` against the pushed or pull-request range, `check:slop` over the whole tree, `check:docs`), the complete Bun test inventory, the Python CI tests, ShellCheck over `scripts/ci/*.sh`, and Actionlint over the workflows. Prose-only plans run `check:docs`. |
| `native` | Rust lint and tests on Linux and Apple Silicon macOS, plus the dataplane's real-helper tests against a built image worker. |
| `integration` | Dragonfly compatibility, the hermetic account flows, calibrated carrier rebind, and handshake reorder against a real edge and daemon. |
| `transport` | Two isolated runners partition the complete functional transport inventory at test level, each using one browser worker. |

Browser checks on Linux run under a virtual X display with SwiftShader, so WebGPU rendering
and pixel assertions are real. Hardware latency benchmarks are not part of CI: shared
runners cannot produce latency evidence. Presentation fixtures assert actual animation-frame
counts and task ordering rather than millisecond wall-time limits. Geometry checks compare the
focused owner's canvas with the PTY sample matching its current container grid; hidden observers
retain their presented frame until a real presentation opportunity. Durable flow-control fixtures
keep an unread lane undrained while an independent transfer completes. Email-code retries reuse
their flow's OPAQUE registration record instead of repeating password stretching.
Uncertain-final rebind faults end on the candidate's native close, in the worker turn that
precedes successor routing. Graphics tool replays retain parser-phase reports and await the
capture and deletion DSR barriers before asserting their pixels. Browser commands stop at
the first failure, and failure artifacts keep traces, screenshots, and reports. Required browser jobs also retain JSON
reports on success for per-test and per-shard timings. `--fully-parallel` partitions individual
tests within large files, so the input matrix does not stay on one shard. Calibrated rebind and
reorder remain separate, unsharded invocations.

The two producers build independently; source waits only for WASM, and browser jobs wait for both.
Artifacts are scoped to the current workflow run, not used as cross-run build caches. WASM
consumers verify the exact clean commit/tree, platform, complete archive inventory and every
output digest before installing. The terminal's existing source-provenance check then runs again.
Display-encoding samples consume the retained zstd fixture directly; source tests never
compile that native helper.
Native consumers use `install:e2e-native-artifacts`: the existing manifest verifier checks the
source closure, compiler bytes, build overrides and executable hashes before installation.
All native producers and consumers use the same Ubuntu runner layout and absolute temporary
artifact directory; a path or toolchain mismatch fails rather than rebuilding silently.

Setup installs LLVM and wasm-pack only for WASM compilation, Chromium and Redis only for browser
consumers, and restores Rust compilation caches only where Cargo runs. Pinned wasm-pack,
lockfile-pinned wasm-bindgen, actionlint and downloaded Bun packages have tool/dependency caches.
Only `main` writes the Rust dependency cache. Accounts, databases, Redis and daemon state are
always fresh. The interactive TUI test compiles its PTY driver in a separate preparation
fixture, then runs the compiler-reported executable against the live daemon. Cold test-profile
compilation has its own deadline and does not consume the authenticated-session test budget.

Additional workflows run beside CI:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [Build deployment](../.github/workflows/build-deployment.yml) | Push to `main`, manual dispatch | Builds the unsigned server, migrations, and web bundle through the Dockerfile's `artifacts` target with the public build pins. It does not deploy. |
| [Dependency audit](../.github/workflows/dependency-audit.yml) | Pull requests, pushes to `main`, a daily schedule, manual dispatch | `bun audit`, `cargo audit --deny yanked`, cargo-deny source/license/backend policies, cargo-vet exact-version review coverage and nine offline policy controls. Diagnostic workspaces receive source/license/backend checks. |
| [Assurance](../.github/workflows/assurance.yml) | Pull requests, pushes to `main`, a daily schedule, manual dispatch | Parser replay, Kani custody proofs, Loom schedules and negative controls, real-session network simulation, and unprivileged profiling-tool checks. Scheduled/manual runs add five bounded coverage-guided parser campaigns with retained corpus and crashes, plus 200 random simulation seeds. |
| [Secret scanning](../.github/workflows/secret-scanning.yml) | Every push, pull requests, manual dispatch | TruffleHog, complementing the local pre-commit hook. |
| [Deploy site](../.github/workflows/deploy-site.yml) | A green CI run of a push to `main`, manual dispatch on `main` | Builds the website through `apps/site/Dockerfile`, serves the result locally, deploys it to its own Railway service, purges the CDN's HTML and proves production serves those bytes. See [releases](releases.md#website-merkursh). |

The assurance aggregate requires successful parser, ownership, bounded-proof, simulation
and diagnostic-tool jobs. Simulation replays every scenario seed and recorded regression;
scheduled and manual runs also sweep 200 random seeds and retain the scenario log, sweep
log and failed-seed regression data. A scheduled or manual parser campaign must also succeed. `Assurance required` is listed in the
checked-in main-protection configuration. Workflow and protection configuration changes
take effect independently; applying remote protection remains a repository operation.

## Extended checks

[Extended CI](../.github/workflows/extended-ci.yml) runs the suites that are too slow or
too environment-specific for every PR. It runs nightly, on manual dispatch, and as part of
every release, one matrix job per suite. The three native/container suites start independently
without WASM or Chromium setup. The two browser suites share one WASM producer and one native
producer within Extended CI. Required CI and Extended CI use separate artifact namespaces when
called by the same release workflow.

| Suite | What it covers |
| --- | --- |
| `test:natlab` | NAT traversal labs in isolated Linux containers. |
| `test:tpm-sim` | The TPM identity backend against a software TPM. |
| `test:graphics:long` | Long graphics convergence tests in the dataplane. |
| `test:e2e:transport:impaired:functional` | The five functional transport specs under calibrated loss and reorder. |
| `test:e2e:edge-topology` | Multi-edge topology. |

`test:e2e:transport:impaired` keeps the hardware latency matrix for a benchmark host and is
not run in CI. A release additionally builds and runs all four daemon binaries natively on
four platforms: Linux x64 and arm64 on Debian 12, and macOS on Apple Silicon and Intel.
Native macOS runner tests do not attest a physical Secure Enclave.

## Cutting a release

A release is one annotated tag on a commit that `main`-push CI has already passed. There is
no second dispatch, no local signer, no manual approval stage. Creating the protected tag is
the release decision. Personal machines pick the release up through `merkur update`.

```sh
git tag -a vMAJOR.MINOR.PATCH -m 'vMAJOR.MINOR.PATCH'
git push origin refs/tags/vMAJOR.MINOR.PATCH
```

The version is a placeholder: use a new numeric version greater than every reservation.
[Release](../.github/workflows/release.yml) then runs these stages, each failing closed:

| Stage | What it does |
| --- | --- |
| `validate` | Reserves a sequence number in the release journal and captures the public deployment configuration. |
| `checks`, `extended` | Reuses CI and Extended CI against the release checkout. |
| `daemon`, `services` | Builds the daemon on all four platforms and the service container images, once. |
| `sign` | On an isolated runner, signs the retained bytes with the ML-DSA-87 release seed and stores them in a draft release. |
| `package-smoke` | Installs the signed daemon packages on every platform. |
| `deploy` | Deploys the application server from the signed bundle, verifies the live signatures match it, deploys the edge and STUN images by registry digest, then publishes the daemon release and verifies its unauthenticated public downloads. |

The `sign` stage receives the seed through `RELEASE_SEED_BASE64`. It installs locked
dependencies without lifecycle scripts, materializes the raw 32-byte seed in an owner-only
temporary file, checks that the derived public pin equals the public build pin, and removes
the seed on exit including failure. No other stage and no deployed host receives it. A
compromise of the signing runner or the release workflow can forge updates. Keep an offline
backup of the seed.

Signing and deployment restore the verified WASM bundle from the release run's required CI
producer before loading the cryptographic helpers. Neither job compiles that bundle.

## Recovery

The `release-state` Git branch is the durable journal. Each update is a child commit made
with a non-force ref update, so a concurrent writer fails instead of replacing state.
Reservations increase beyond every consumed sequence. A run cannot change its commit,
version, or sequence, and a newer reservation prevents an older run from deploying again.
A retry rejects changed destinations, public pins, or minimum-sequence policy before any
privileged work.

| When it failed | What to do |
| --- | --- |
| Before the signed assets were retained | The reservation is consumed. Fix the problem and push a higher version tag. Never delete a tag to reuse it. |
| After retention | Rerun the same workflow run. The signer re-reads the journal, restores the existing signed assets, and never rebuilds or re-signs retained bytes. |
| Retained manifests expired | Cut a forward release with a new sequence. |

Deployment retries redeploy the exact same signed bundle and verify that deployment. A
forward fix must respect every installed sequence floor. Never restore old daemon binaries as
an automatic rollback once a newer release has been consumed.

## One-time activation

The checked-in workflows do not configure GitHub. Complete this before the first release
tag; the workflow fails closed on missing state or credentials.

1. Merge the workflows and obtain a successful `main`-push CI run. Apply
   [main protection](../.github/main-protection.json), and also require the status context
   the CLA action emits once you have seen it on a real PR.
2. Protect the `v*` tag namespace: only release maintainers may create tags, and updates
   and deletions have no bypass. Protect the `release-state` branch against deletion and
   force pushes, and allow the release workflow's token to append commits to it without a PR.
3. Create the `release-signing` and `production` environments. Each uses
   the **tag** deployment policy `v*` with no branch rule and no required reviewers; a
   `main`-only policy rejects tag workflows. Disconnect any hosting provider's direct Git
   integration so only the release workflow deploys. The website has its own `site`
   environment with the **branch** policy `main`, because it deploys from `main`
   ([releases](releases.md#website-merkursh)).
4. Configure the variables and scoped secrets below. Reuse the existing release seed; never
   generate a new key or change installed pins.
5. Initialize the `release-state` branch with one `state.json` holding `baselineVersion`,
   `baselineCommit`, `sequenceFloor`, and an empty `releases` array. Derive the floor from
   verified signed release history plus any consumed unpublished sequences; the baseline
   commit is the previously deployed source commit. Never infer the counter from a version
   or a timestamp.
6. Make release assets publicly downloadable without authentication. Rehearse failure and
   resume with a test signing key before enabling production credentials.

| Scope | Name | Value |
| --- | --- | --- |
| Repository variable | `MERKUR_RELEASE_MLDSA87_PUBLIC_KEY` | The canonical public release pin |
| Repository variable | `MERKUR_OPAQUE_SERVER_PUBLIC_KEY` | The production OPAQUE pin |
| Repository variable | `MERKUR_SERVER_ORIGIN` | The application's production HTTPS origin |
| Repository variables | `MERKUR_SITE_ORIGIN`, `MERKUR_SITE_RYBBIT_SITE_ID`, `RAILWAY_SITE_SERVICE_ID` | The website's origin, its Rybbit site, and its deployment destination |
| Repository variable | `RELEASE_MINIMUM_SEQUENCE` | Positive prerequisite sequence; raise it only deliberately |
| Repository variables | `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` | The application server's deployment destination |
| Repository variable | `STUN_APPS` | Space-separated names of the deployed STUN responders |
| `release-signing` secret | `RELEASE_SEED_BASE64` | Base64 of the raw 32-byte release seed |
| `production` secrets | `RAILWAY_TOKEN`, `FLY_API_TOKEN` | Deployment credentials for the application server and for the edge and STUN services, scoped to those services only |
| `site` secret | `RAILWAY_TOKEN` | Deployment credential for the website's service only |

## Terminal canary

`bun run ci:canary <device name>` proves a deployment end to end from a browser: it signs in
at `SERVER_ORIGIN` as `CANARY_USERNAME` with `CANARY_PASSWORD`, opens a session on the named
device, types a command and requires its output. The release workflow does not run it,
because it owns no daemon; a deployment runs it against a device of its own after a release.
The account is a dedicated test account, created once by hand: its name is an email address
when the server runs `AUTH_IDENTITY=email`, and sign-up waits for the mailed code.
