# CI and release operations

What GitHub Actions runs for Merkur, what each workflow gates, how a release is cut, how a
failed release is recovered, and the one-time setup a repository needs before its first
release tag. The workflows live in `.github/workflows`; the release helpers they call live
in `scripts/ci`.

## What CI runs

[CI](../.github/workflows/ci.yml) is the branch-protection gate. It runs on every pull
request at its merge commit and on every push to `main` at the exact commit. It holds no
deployment secrets. Every run starts every job: Bazel decides what work a commit needs,
running the tests whose inputs changed and answering the rest from the BuildBuddy remote
cache, which only CI writes.

`CI required` fails unless every job succeeded. The workflow itself is never omitted by path
filtering.

| Job | What it proves |
| --- | --- |
| `artifacts` | Builds the WebAssembly packages (`//tools/bazel/wasm:sync`) and the native programs the browser suites run (`//tools/bazel/native:sync`, release profile) into the remote cache, with the commands every consumer runs, so each consumer's build is a cache hit. |
| `test` | `bazel test //...` on Linux and Apple Silicon macOS: every Rust, WebAssembly and Bun test, Clippy's ratchet (`//:rust_lint`), and the static gates (`//:static_gates`: `check:types`, `check:lint`, `check:latency-boundaries`, `check:span-lifetimes`, `check:span-attributes`, `check:dead`, `check:ratchet` against `fallow-baselines/`, `check:slop` against its baseline, `check:docs`, and `check:bazel-sources`). The dataplane's real-helper tests take the image helper their test target builds; the browser tests launch Bazel's pinned Chromium. |
| `workflow` | The Python CI tests, ShellCheck over `scripts/ci/*.sh`, and Actionlint over the workflows. |
| `integration` | Three runners: Dragonfly compatibility with the hermetic account flows, calibrated carrier rebind, and handshake reorder, each against a real edge and daemon. |
| `transport` | Six isolated runners partition the complete functional transport inventory at test level, each using one browser worker. |

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

Browser jobs wait for `artifacts`, then sync the WebAssembly packages and the native programs
from the remote cache (`bun run build:wasm && bun run build:native`); the harnesses sync again
themselves, as Bazel's no-op. A fork's pull request has no cache key and builds locally.

Setup installs Bazel where Bazel builds, Chromium and Redis only for the browser jobs, and
restores Rust compilation caches only where Cargo runs. Bazel reads and, in CI, writes the
BuildBuddy remote cache; actionlint and downloaded Bun packages have tool/dependency caches.
Only `main` writes the Rust dependency cache, one per runner and native task. Assurance keys its
caches by toolchain and lockfile, never by commit, so it never evicts the Rust caches from the
Actions cache. Accounts, databases, Redis and daemon state are always fresh. The interactive TUI test compiles its PTY driver in a separate preparation
fixture (`bazel build //apps/tui:interactive_live`), then runs it against the live daemon. Its
build has its own deadline and does not consume the authenticated-session test budget.

Additional workflows run beside CI:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [Build deployment](../.github/workflows/build-deployment.yml) | Push to `main`, manual dispatch | Builds the unsigned server, migrations, and web bundle with Bazel (`//tools/bazel/release:deployment`) and the public build pins. It does not deploy. |
| [Release build](../.github/workflows/release-build.yml) | A nightly schedule, manual dispatch, and each release | Builds every artifact a release signs with Bazel and a release identity (`v0.0.0`, sequence 1, outside a release): the daemon on all four platforms with its profile-guided dataplane, the server deployment, and the edge and STUN binaries. It smoke-tests each executable where it ships and checks the exact unsigned inventory signing accepts. It signs, publishes and deploys nothing. |
| [Profile](../.github/workflows/profile.yml) | Manual dispatch | `bun run profile:sim --cpu` on a Linux runner, with `perf_event_paranoid` lowered so samply can sample: the simulated display pipeline's spans and CPU samples in one Perfetto trace, the query catalogue's answers in the job summary, and the capture directory as an artifact. It gates nothing. |
| [Instructions](../.github/workflows/instructions.yml) | Push to `main`, manual dispatch | `scripts/bench-instructions.ts`: the instructions each dataplane benchmark (the `bench:*` scripts that run `//apps/daemon/dataplane:unit_release`) executes under Cachegrind at five samples, beside the previous push's counts in the job summary, and the counts as an artifact. A count does not move with the runner's load. It gates nothing. |
| [Dependency audit](../.github/workflows/dependency-audit.yml) | Pull requests, pushes to `main`, a daily schedule, manual dispatch | `pnpm audit`, `cargo audit --deny yanked`, cargo-deny source/license/backend policies, the `pnpm-lock.yaml` source/spec/license/install-script policy, cargo-vet exact-version review coverage and ten offline policy controls. Diagnostic workspaces receive source/license/backend checks. |
| [Assurance](../.github/workflows/assurance.yml) | Pull requests, each completed `main` CI run (at that run's commit), a daily schedule, manual dispatch | Parser replay, Kani custody proofs and their negative controls, real-session network simulation, and the profile reader's accounting check; the Loom models and the kernel profiler's tests run in CI's `bazel test //...`. Scheduled/manual runs add five bounded coverage-guided parser campaigns with retained corpus and crashes, plus 200 random simulation seeds. |
| [Secret scanning](../.github/workflows/secret-scanning.yml) | Every push, pull requests, manual dispatch | TruffleHog, complementing the local pre-commit hook. |
| [CodeQL](../.github/workflows/codeql.yml) | Pull requests, each completed `main` CI run (at that run's commit), a weekly schedule, manual dispatch | Code scanning of TypeScript, Rust, the workflows and the Python tooling, with Merkur's models and queries; `Query tests` checks every query against its fixtures. See [static analysis](security.md#static-analysis). |
| [Dependency updates](../.github/workflows/renovate.yml) | A nightly schedule, a box ticked on the Dependency Dashboard issue, manual dispatch | Renovate proposes dependency, action, image and tool updates as pull requests, which the workflows above then test. See [Dependency updates](#dependency-updates). |
| [Deploy site](../.github/workflows/deploy-site.yml) | A green CI run of a push to `main`, manual dispatch on `main` | Builds the website with Bazel (`//tools/bazel/release:site`), serves the result locally, installs it on the app host through a key that can run only the site installer, purges both site hosts from Cloudflare's cache and proves production serves those bytes. See [releases](releases.md#website-merkursh). |

The assurance aggregate requires successful parser, ownership, bounded-proof, simulation
and diagnostic-tool jobs. On `main`, Assurance and CodeQL start when CI finishes, so they
never hold runner slots CI's browser shards are waiting for; a CI run cancelled by a newer push
is skipped, since that push's run covers it. Simulation replays every scenario seed and recorded regression;
scheduled and manual runs also sweep 200 random seeds and retain the scenario log, sweep
log and failed-seed regression data. A scheduled or manual parser campaign must also succeed. `Assurance required` is listed in the
checked-in main-protection configuration. Workflow and protection configuration changes
take effect independently; applying remote protection remains a repository operation.

## Extended checks

[Extended CI](../.github/workflows/extended-ci.yml) runs the suites that are too slow or
too environment-specific for every PR. It runs nightly, on manual dispatch, and as part of
every release, one matrix job per suite. The three native/container suites start independently
without WASM or Chromium setup; the TPM simulator and graphics suites are Bazel tests. The two
browser suites wait for Extended CI's own `artifacts` job and sync from the remote cache.

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

Linux daemon smoke tests, NAT labs and the TPM simulator pull digest-pinned Debian and Rust
images, Docker's official images, from Google's public Docker Hub mirror. Anonymous pulls
from Docker Hub and from Amazon ECR Public are both quota-limited per address, and GitHub's
hosted runners share their addresses. A run fails if its pinned image is unavailable.

## Dependency updates

[Dependency updates](../.github/workflows/renovate.yml) runs
[Renovate](https://docs.renovatebot.com/) every night from a digest-pinned image, configured
by [`.github/renovate.json5`](../.github/renovate.json5). It reads the Cargo and Bun
manifests, the actions the workflows pin, the image digests in the compose files, the Rust
and Node pins, and the tool versions the setup scripts and workflows install.
Each change is a pull request from a `renovate/` branch, so CI, the dependency audit,
assurance and secret scanning run on it like on any other. Nothing merges on its own.

- Ordinary updates open early on Monday, five pull requests at most at a time. The rest wait
  on the Dependency Dashboard issue, where ticking one opens it on the run that edit starts.
  A release is proposed seven days after it was published. A fix for an advisory against a
  direct dependency opens on the next run, whatever the day and the age, and the dashboard
  lists every advisory Renovate matched. An advisory against a transitive dependency is the
  daily dependency audit's to report; its fix arrives with the lock refresh.
- A manifest range moves only when a release falls outside it. Releases within a range, and
  every transitive dependency, arrive with a weekly lock refresh: one pull request for the
  Cargo locks and one for `pnpm-lock.yaml`.
- A Cargo pull request regenerates `tools/sim/Cargo.lock` and `tools/bolero/Cargo.lock`
  through `test:sim:update-lock` and `test:fuzz:update-lock`. A catalog entry moves in
  `pnpm-workspace.yaml`, and `pnpm-lock.yaml` follows.
- Packages that have to agree move in one pull request: the Rust toolchain with its builder
  images, Solid's release candidate, the RustCrypto crates, and the workflows' minor action
  updates.
- Renovate does not write `supply-chain/`. A Cargo pull request fails the dependency audit's
  cargo-vet step until each new crate version has been reviewed and its audit or exemption
  pushed to the branch ([policy](security.md#dependency-source-and-audit-policy)).
- Six updates wait on the dashboard until they are ticked, because the version is not the
  whole change: the Bun runtime, pnpm, LLVM and TruffleHog are installed by archive checksum,
  Kani is tied to a nightly toolchain, and a vendored patch crate moves by carrying its patches
  onto the new upstream source. An advisory against one of them opens its pull request unasked. For a
  vendored crate that pull request cannot build until the source follows, because the
  workspace lock still names the old version.
- The Bazel module's dependencies and `.bazelversion` move like any other update; the Rust
  release in `MODULE.bazel` moves with `rust-toolchain.toml` in the Rust toolchain group. The
  deployment CLIs that `release.yml` and `deploy-site.yml` install are not watched: no pull
  request can exercise them.

Renovate authenticates as a GitHub App owned by the organization, so its commits are signed
by GitHub and its pull requests start the other workflows. Activation is three steps:

1. Create the App `merkur-renovate` with no webhook and install it on this repository only.
   It needs these repository permissions: read on administration, Dependabot alerts and
   metadata; read and write on checks, commit statuses, contents, issues, pull requests and
   workflows. The CLA workflow allowlists `merkur-renovate[bot]` by that name.
2. Create the `dependency-updates` environment with the **branch** deployment policy `main`.
3. Store the App's client ID as the environment variable `RENOVATE_APP_CLIENT_ID` and its
   private key as the environment secret `RENOVATE_APP_PRIVATE_KEY`.

`gh workflow run renovate.yml -f dry-run=true` logs every branch and pull request a run would
create without creating one.

## Cutting a release

A release is one annotated tag on a commit that `main`-push CI has already passed. There is
no second dispatch, no local signer, no manual approval stage. Creating the protected tag is
the release decision. Every daemon converges to the release on its own as its server switches
([Convergence](releases.md#convergence)).

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
| `build` | [Release build](../.github/workflows/release-build.yml): the daemon on all four platforms, the deployment and the edge and STUN binaries, once, with their smoke tests and the unsigned inventory check. |
| `sign` | On an isolated runner, signs the retained bytes with the ML-DSA-87 release seed and stores them in a draft release. |
| `package-smoke` | Installs the signed daemon packages on every platform. |
| `deploy` | Deploys the application server from the signed bundle to the app host over pinned SSH, verifies it runs the verified executable and that the live signatures match the bundle, deploys the edge and STUN binaries to every service host over pinned SSH and verifies each runs them, then publishes the daemon release and verifies its unauthenticated public downloads. |

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
   the CLA action emits once you have seen it on a real PR. The CLA workflow records
   signatures on the `cla-signatures` branch, which has to exist and stay unprotected.
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
| Repository variables | `MERKUR_SITE_ORIGIN`, `MERKUR_SITE_RYBBIT_SITE_ID` | The website's origin and its Rybbit site |
| Repository variable | `CLOUDFLARE_ZONE_ID` | The `merkur.sh` zone, whose cache the site deploy purges |
| Repository variable | `RELEASE_MINIMUM_SEQUENCE` | Positive prerequisite sequence; raise it only deliberately |
| `release-signing` secret | `RELEASE_SEED_BASE64` | Base64 of the raw 32-byte release seed |
| `production` secret | `SERVICE_HOSTS_SSH_KEY` | Root SSH key for the app host and the edge and STUN service hosts in `deploy/service-hosts.json`, whose SSH host keys the manifest pins |
| `site` secrets | `SITE_DEPLOY_SSH_KEY`, `SITE_CLOUDFLARE_PURGE_TOKEN` | A key the app host lets run only its site installer, and a token that can only purge the zone's cache |

## Terminal canary

`bun run ci:canary <device name>` proves a deployment end to end from a browser: it signs in
at `SERVER_ORIGIN` as `CANARY_USERNAME` with `CANARY_PASSWORD`, opens a session on the named
device, types a command and requires its output. The release workflow does not run it,
because it owns no daemon; a deployment runs it against a device of its own after a release.
The account is a dedicated test account, created once by hand: its name is an email address
when the server runs `AUTH_IDENTITY=email`, and sign-up waits for the mailed code.
