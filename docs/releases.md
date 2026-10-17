# Release Signing

Merkur's daemon release trust chain uses a canonical manifest signed with ML-DSA-87 under the fixed
FIPS 204 context `merkur-release-manifest`. There is no algorithm identifier, key identifier,
legacy signature reader, unsigned checksum mode, or verification fallback.

Web and deployment bundles use the same CI-held release key with separate FIPS 204 contexts:
`merkur-web-release-manifest` and `merkur-deployment-release-manifest`. The release verifies
the complete signed bundle before it installs it. Only the protected signing job receives the seed.

[CI operations](ci.md) defines the tag-triggered release pipeline, one-time setup and recovery.
The commands below document its build/signing primitives; production releases run in CI.

## Web Build Signing

Finish building all web assets, including any precompressed copies, before signing. Work
on a fixed directory: neither command locks the build against concurrent writers, and
verification proves the bytes inspected, not future changes to that directory.

```sh
# Build from the intended source checkout. This label records the signer's assertion;
# it is not a source/build provenance attestation or a reproducible-build check.
WEB_COMMIT=$(git rev-parse HEAD)
# Supply the public OPAQUE and release pins in the build environment.
bun --no-env-file run --cwd apps/web build

# In the protected signing job, with the finished build directory and the existing
# independently recorded public-key pin (see Key Custody below):
: "${MERKUR_RELEASE_MLDSA87_PUBLIC_KEY:?set the trusted release public-key pin}"
export MERKUR_RELEASE_MLDSA87_PUBLIC_KEY
bun run web:sign -- \
  --directory apps/web/dist \
  --commit "$WEB_COMMIT" \
  --seed-file "$SEED_FILE"

# On the verification machine, use the trusted public-key pin and the independently
# selected expected commit. The signing seed is not needed here.
bun run web:verify -- --directory apps/web/dist --commit "$WEB_COMMIT"
```

The root `bun run build:web` command is the local-development wrapper: it resolves the
public OPAQUE pin from `apps/server/.env` plus literal process overrides and projects only
public inputs into the Vite build. Production artifact builds use the package command
above with explicit public inputs; the deployment build uses that same boundary.

Both commands default to the generated web build directory shown above when `--directory` is omitted. The signer creates
`merkur-web-release.json` and `merkur-web-release.sig` in that directory and refuses to
overwrite either file. Rebuild into a fresh directory to sign another build. The seed
must be a raw 32-byte, owner-only file outside the build directory; its derived public
key must match `MERKUR_RELEASE_MLDSA87_PUBLIC_KEY`.

The newline-terminated canonical JSON contains `commit` (a full lowercase 40-character
Git SHA) and `files` (sorted by relative path, each with `path`, byte `size`, and lowercase
SHA-512 digest `sha512`). Every regular file is covered, including HTML, JavaScript,
workers, WASM, styles, and compressed copies. Only the two root-level signature metadata
files are excluded. A non-empty `index.html` is required; symlinks and special files are
rejected. Empty directories are not part of the manifest. The signature uses the same
canonical unpadded-base64url encoding as daemon releases, with no trailing newline.

Verification requires a valid web-context signature, then reconstructs the manifest
from the actual directory and expected commit and compares its exact bytes. Missing,
changed, or additional files, a different commit, and noncanonical metadata all fail.
There is no persistent rollback counter or expiry for web artifacts: the caller selects
the expected commit independently, and the signature alone does not establish freshness.

This is artifact authentication at the explicit verification step. It does not establish
browser first-load trust or protect assets modified after verification. The release enforces
the separate deployment verification step below. Keep the seed off build hosts and the application server.

## Signed Deployment

Bazel builds the unsigned deployment on Linux x64, the server's platform
(`//tools/bazel/release:deployment`, `scripts/build-deployment.ts`): the server executable,
migrations, and finished web assets (including Brotli copies), as `deployment.tar.gz`. The
release installs a finished signed directory named `deployment` at the repository root on
the app host. Nothing rebuilds signed files.

```sh
DEPLOYMENT_COMMIT=$(git rev-parse HEAD)
: "${MERKUR_RELEASE_MLDSA87_PUBLIC_KEY:?set the trusted release public-key pin}"
: "${OPAQUE_SERVER_PUBLIC_KEY:?set the deployed OPAQUE public-key pin}"
export MERKUR_RELEASE_MLDSA87_PUBLIC_KEY

# Build on Linux x64 and extract into a fresh directory. No signing seed enters the build.
bazel build --config=release //tools/bazel/release:deployment \
  "--//tools/bazel/release:commit=$DEPLOYMENT_COMMIT" \
  "--//tools/bazel/release:release_public_key=$MERKUR_RELEASE_MLDSA87_PUBLIC_KEY" \
  "--//tools/bazel/release:opaque_pin=$OPAQUE_SERVER_PUBLIC_KEY"
mkdir deployment
tar -xzf "$(bazel info --config=release execution_root)/$(bazel cquery --config=release \
  --output=files //tools/bazel/release:deployment)" -C deployment

# In the isolated signing job, sign the web files first, then the
# complete deployment, which also binds the web manifest and detached signature.
bun run web:sign -- --directory deployment/web --commit "$DEPLOYMENT_COMMIT" \
  --seed-file "$SEED_FILE"
bun run deployment:sign -- --directory deployment --commit "$DEPLOYMENT_COMMIT" \
  --seed-file "$SEED_FILE"

# Return only the signed bundle to the deploying job, at repository-root deployment/.
bun run deployment:verify -- --directory deployment --commit "$DEPLOYMENT_COMMIT"
```

The deployment commands default to `deployment`. Signing creates
`merkur-deployment-release.json` and `merkur-deployment-release.sig`, refusing overwrites.
The manifest covers every file in the bundle except those two root proof files. Verification
checks both signatures, the expected commit, and the exact file sets. A non-empty server
executable and migration set are required. Missing, changed, additional, or unsigned files
fail verification. On the app host the signed files are root-owned and read-only, and the
server sees them at `/deployment`, with the signed migrations at `/migrations`.

Nothing in the deployment comes from an image. Bun is installed from its versioned GitHub
release archives, checked against pinned SHA-256 digests, and the WebAssembly packages the
verifier embeds arrive built by Bazel, whose wasm-bindgen CLI is the version `Cargo.lock`
resolves and whose binaryen is pinned by checksum. The edge and STUN are release binaries
Bazel builds (`//tools/bazel/release:service_binaries`). The app host's libSQL server (sqld)
and Dragonfly are upstream images pinned by digest in `deploy/app/compose.yaml`; Debian
packages come from Debian's authenticated repositories and update unattended. Application
signatures do not cover the host's operating system, its shared libraries or those images.
Review and refresh these pins when publishing security updates.

### The app host

The application server, its database, Dragonfly and the website run on one host, `app` in
`deploy/service-hosts.json`. Caddy terminates TLS (`deploy/app/Caddyfile`). `app.merkur.sh`
points at the host directly, with a Let's Encrypt certificate Caddy holds, so no third party
decrypts the app's traffic: TLS ends on the host, and Caddy is the server's one proxy
(`TRUSTED_PROXY_HOPS=1`). Cloudflare could not shield the terminal path anyway, which runs
over UDP to the edges, and Hetzner's network mitigation covers volumetric attacks on the
host. The website's names answer only Cloudflare (below). sqld and Dragonfly listen on
loopback only (`deploy/app/compose.yaml`).

The server and the website are systemd units (`deploy/app/merkur-server.service`,
`deploy/app/merkur-site.service`) that run as transient users with no capabilities,
`NoNewPrivileges`, a strict read-only system, private `/tmp`, an owner-only creation mask
and a system-call filter, listening on loopback for Caddy. Each release unpacks into
`/usr/local/lib/merkur/server/<version>`, normalized to directory mode 0555, file mode 0444
and an executable 0555, so supplied setuid/setgid modes do not survive; `current` names the
running one, and the unit binds it read-only at `/deployment` and its migrations at
`/migrations`. A version is installed once: shipping it again with different bytes fails.
The server holds no durable state of its own: its database is sqld, reached through `DB_URL`.

The edge and STUN run under systemd on the service hosts (`apps/edge/merkur-edge.service`,
`apps/stun/merkur-stun.service`) the same way. Only the edge's egress cap runs as root,
before the relay starts; the edge's identity lives in its unit's state directory.

Production server deployment is a stage of the tag-triggered release workflow
(`scripts/ci/deploy-services.sh`). CI verifies the signed bundle, ships that verified
directory to the app host over SSH pinned to the host's key in the manifest, and runs
`scripts/ci/install-app-release.sh` there, which restarts the server, waits for it to log
`server_started` and reports the SHA-512 of the executable it runs; CI requires that digest to
be the verified one. Secrets never travel: the host holds them in `/etc/merkur/server.env`
and `/etc/merkur/data.env`. Retain the exact local signed bundle so rollout checks can
compare it with production:

```sh
bun run deployment:check-server -- --directory deployment \
  --commit "$DEPLOYMENT_COMMIT" --origin https://your-merkur-origin.example
```

This verifies the local bytes and checks that `/api/build-identity` presents those exact
server and client signatures. Release CI requires this proof before publishing daemon artifacts.

### Push checks, tag releases

[Build deployment](../.github/workflows/build-deployment.yml) retains unsigned candidates
from main. [Release](../.github/workflows/release.yml) reserves a durable monotonic sequence,
builds all components from one tagged commit, signs with the protected GitHub environment
seed, and retains exact bytes before production changes. It deploys the server to the app host,
then the edge and STUN to every service host in `deploy/service-hosts.json`, over SSH pinned to
each host's key, and publishes the daemon assets once each host reports running exactly the
retained binaries. See
[CI operations](ci.md).

### Settings Verification ID

Each web build emits a fresh build marker, embedded in the client and compiled into its
server. The server checks the signed proofs before opening HTTP and exposes them through
an uncached `/api/build-identity` response. Source development serves `null`.

The deployment build sets `MERKUR_VERSION` to the required `MERKUR_BUILD_COMMIT`
for both server and browser. `/api/version`, health version, and telemetry therefore
identify the deployment commit; source runs report `dev`.

Opening account settings automatically verifies both ML-DSA-87 signatures, their commit
and manifest bindings, and the loaded client's embedded marker. The Build card's header
row carries one sentence and one verdict: a “Verifying” chip while the proofs are in
flight, with a skeleton holding the ID row's footprint; a green “Verified” chip on
success, with a second row showing the UUID-shaped ID, the short commit, and one icon-only
copy button; a “Reload” button when the client is stale; an “Unverified” chip when the
proof is invalid or unavailable; a “Development” chip on an unpinned local build.

The ID is the first 128 bits of domain-separated SHA-256 over the ordered server and client
signatures, formatted as five hexadecimal groups. It identifies that exact signed pair;
re-signing produces a different ID. It is informational and never controls protocol behavior.
The CLI prints the same ID for comparison through an independently trusted channel.

This authenticates the reported artifact identity, not the running host or all code already
loaded by the browser. It is not remote attestation. The browser verifier and its pin still
arrive from the origin, so a compromised origin can replace the verifier or draw a false
checkmark. Independent provisioning remains necessary for first-load trust.

## Daemon Release Manifest

Releases are public GitHub release assets, and GitHub is an untrusted distribution transport.
The updater downloads directly from `github.com/merkur-sh/merkur/releases` with no token and no
API call: it reads the newest version out of `releases/latest/download/merkur-release.json`,
then fetches the manifest and its signature again by that tag, so the verified pair cannot
straddle two releases. A daemon accepts a release only after its compiled public-key pin
verifies the exact manifest bytes. The manifest binds:

- a monotonically increasing release `sequence`;
- the exact `vMAJOR.MINOR.PATCH` tag;
- an expiry timestamp in Unix milliseconds;
- the minimum already-installed sequence allowed to consume the release;
- all four exact artifact names (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), byte
  sizes, and lowercase SHA-512 digests.

The daemon persists the highest accepted sequence and the SHA-512 hash of its manifest in
`~/.merkur/release-trust.json`. The write is flushed, atomically renamed, and directory-synced
under an Effect-owned lock. A lower sequence or a different manifest reusing the same sequence is
rejected. The sequence embedded in the running binary remains a rollback floor even if no state
file exists.

Release archives are never accumulated in memory. The daemon streams the response into an
exclusive mode-0600 file beside its final download path, incrementally enforces the manifest's
exact size and SHA-512 digest, flushes the file, and publishes it with one atomic rename. A failed,
timed-out, retried, or interrupted attempt removes its uniquely named temporary file. Metadata
requests retain their short fixed deadline; archive downloads instead use separate header and
reset-on-progress inactivity deadlines plus a whole-attempt deadline derived from the signed size,
so a healthy large transfer is not treated like a hung metadata lookup.

## First Install: Trust On First Use

`curl -fsSL <origin>/install | sh` installs the daemon. The script the server renders is thin: it
picks the platform, downloads the newest archive, `merkur-release.json`, and `merkur-release.sig`
from `releases/latest/download/` into `~/.merkur/install.*` (not `/tmp`, which hardened hosts
mount `noexec`), extracts only the `merkur` binary, and runs
`merkur setup <archive> <manifest> <signature>`. The script verifies nothing itself; there is one
verifier. Setup requires the manifest to name its own version and sequence, verifies the ML-DSA-87
signature against its compiled pin, and then installs through the updater's own pipeline: the same
streamed size and SHA-512 check (read through a `file:` URL), rollback floor, `versions/<version>`
extraction, and atomic `current` swap. It links `~/.merkur/bin/merkur -> ../current/merkur`,
appends one marked `PATH` block to the startup file of the account's login shell, read from the
password database (fish gets `conf.d/merkur.fish`), and prints the release key's fingerprint. Re-running it is idempotent, and
the rollback floor still refuses a downgrade. With no daemon config the service is not installed:
an unlinked daemon exits on its missing config, so a supervised unit would only crash-loop.

This first step is trust on first use, and Merkur claims no more for it. A script, a binary, and
the key compiled into that binary all arrive over HTTPS, so whoever controls that channel can
replace all three together, and the binary vouching for its own release proves consistency, not
origin. What the step does give: the fingerprint (plain SHA-256 of the 2,592 raw key bytes, as
eight groups of eight hex digits; `merkur release-key` prints it again) can be compared with the
value published in the README and `SECURITY.md`, a channel this download did not come through.
From the first update on, every release is verified against that key. Deployments that need a
post-quantum root for the first install still provision the daemon and its pin through a trusted
image or offline media.

## Key Custody

The raw 32-byte release seed is stored as a base64-encoded secret in the protected
`release-signing` GitHub environment, restricted to protected release tags. The signing job
checks its derived public key against the independently configured build pin and removes its
owner-only temporary seed file on completion or failure. Keep an offline backup. Hosted
services, build jobs and box hosts receive no seed. The session-authorization signing key is
separate.

Release automation holds signing authority: a compromised signing runner or trusted workflow
can steal the seed or forge releases. This is a deliberate custody choice, not a
hardware-isolated signing service. See [CI setup](ci.md#one-time-activation).

ML-DSA-87 is the only release signature. A key change requires a separate, explicit
trust-root cutover.

## Profile-guided dataplane

A release's `merkur-dataplane` is profile-guided (`//tools/bazel/release:merkur-dataplane`).
Bazel builds the dataplane's unit-suite harness instrumented (`:dataplane_instrumented`),
trains it on the suite for breadth and on the display pipeline and scroll benchmarks for
weights (`:dataplane_profile`), merges the profile with the `llvm-profdata` of the pinned
Rust toolchain's `llvm-tools`, so it matches rustc's LLVM, and rebuilds every crate of the
dataplane with it. Training runs the target's own executable on the build machine: Linux
builds natively on each architecture, and `darwin-x64` builds on Apple Silicon and trains
under Rosetta, where the image worker cannot start its sandbox, so the suite's real-helper
tests fail there and its profile carries no weight for those paths. Bazel caches the profile by
its inputs, so an unchanged dataplane is not trained again.

## Build the daemon

`scripts/ci/build-daemon.sh` builds one platform's archive with Bazel, and
`scripts/ci/smoke-daemon.sh` smoke-tests its four executables where they ship, including helper
confinement: Linux in a clean Debian 12 container, the ABI floor (the toolchain links against a
glibc 2.31 sysroot), and each macOS archive on a runner of its own architecture. The
release identity reaches the build as settings, and a release refuses a missing or
noncanonical one. `SEQUENCE` is a positive monotonic security counter and must never be
reused, even when a release is withdrawn. The image worker must emit its READY marker under an
empty environment, after entering confinement and before reading image data.

```sh
: "${VERSION:?set VERSION to the exact vMAJOR.MINOR.PATCH tag}"
: "${SEQUENCE:?set SEQUENCE to the new monotonic release sequence}"
: "${MERKUR_RELEASE_MLDSA87_PUBLIC_KEY:?set the trusted release public-key pin}"
: "${SERVER_ORIGIN:?set the canonical HTTPS account origin}"
: "${OPAQUE_PIN:?set the trusted account OPAQUE pin}"

PLATFORM=darwin-arm64 bash scripts/ci/build-daemon.sh
PLATFORM=darwin-arm64 bash scripts/ci/smoke-daemon.sh
```

The archive is `//tools/bazel/release:daemon`: `merkur`, compiled by
`scripts/compile-daemon-cli.ts` with the version, sequence and release key stamped in, the
profile-guided dataplane, the image worker and the terminal client, which compiles in the
account origin and OPAQUE pin. Each entry is mode 0755, owned by root, with no dates. A Linux
build also writes the release verifier, `verify-<platform>`, which the signing and deployment
jobs run.

## Sign And Publish

The release workflow derives the version from its immutable trigger tag and the sequence
from its durable reservation. `RELEASE_MINIMUM_SEQUENCE` controls the oldest installation
allowed to consume it. CI signs with a 29-day expiry inside the verifier's 30-day bound and
retains the exact signed bytes before deployment. A retry restores them without changing the
expiry or signature. Only a new release may receive a new sequence or signature.

Publication changes the existing draft release to public after service proofs pass. It does
not create or move the trigger tag. All four daemon archives, their manifest/signature and
notices are published together. [CI recovery](ci.md#recovery) covers failures before and after
retention.

`merkur-release.sig` is exactly 6,170 canonical unpadded-base64url bytes with no trailing newline.
`merkur-release.json` is the exact newline-terminated canonical JSON emitted by the signing tool.
Do not edit either file after signing. Each archive contains exactly `merkur`, `merkur-dataplane`, `merkur-image-worker`, and `merkur-tui`.
The updater requires all four regular executable files before activation; the dataplane launches
the image worker from its own version directory. Release tarballs must use the simple ustar command shown
above: the updater rejects PAX metadata, AppleDouble files, links, devices, extra paths, traversal,
unsafe modes, and expansion beyond its fixed bound before invoking `tar`.

After publication, CI downloads the public assets without a token and holds them to the
retained digests. Personal computers update separately, through `merkur update`.

Hardware identity builds on macOS require Xcode Command Line Tools (`xcrun`, `swiftc`) with the
macOS 26 SDK, whose CryptoKit declares the enclave's ML-DSA-87 keys; the binary still runs on
macOS 14, where the enclave seals the seed instead. The shared custody Swift bridge is compiled into the dataplane and terminal client; Linux builds use the Rust TPM
codec and `/dev/tpmrm0`, with no libtss2 or OpenSSL dependency from identity custody. Ship the
browser/WASM, server schema and daemon together. A schema hard cut invalidates existing daemon
links; relink hosts and reprovision boxes. Runtime hardware failure
never downgrades identity custody. See [hardware identity](security.md#hardware-bound-daemon-identity).

Production migration modules are bundled with their runtime imports before signing. They
are loaded by the compiled server from the signed migration directory; the runtime does
not need a separate `node_modules` tree.

## Website (merkur.sh)

The public site is `apps/site`, served from the app host behind Cloudflare at
`https://merkur.sh`; `www.merkur.sh` reaches the same server, which answers every path there
with a 308 to the bare host. The app is a different origin, `https://app.merkur.sh`: the
app's origin is bound into OPAQUE and delegation, and the site shares nothing with it. The
site answers one path on the app's behalf, `/install`, with a 308 to the app's installer, so `curl -fsSL merkur.sh/install | sh` works as the page prints it.
[Deploy site](../.github/workflows/deploy-site.yml) runs for each commit of `main` whose CI
run ends green, and can be dispatched by hand. The app is released only by a tag.

Cloudflare reaches the host with the zone's Origin CA certificate. Caddy refuses the site's
names to any other peer and extends `X-Forwarded-For` only for Cloudflare's ranges, so the
site's `TRUSTED_PROXY_HOPS=2` reads the visitor's address.

### No signing, by design

The app's web bundle and server are signed offline because the browser checks them: the
Settings Verification ID above is only as good as the signature behind it. Nothing checks the
site's bytes at the point of use, and the site holds nothing a signature would protect. It
sets no cookie, holds no credential, key or session, and its one cross-origin write is the
Boxes waitlist post, which the app server validates on its own. A tampered site deploy can
change what the page says; it cannot act for an account or weaken the app's first-load trust.
So the site ships the bytes CI built and checked, unsigned, and its CSP
(`default-src 'none'`, `connect-src 'self' https://app.merkur.sh`,
`form-action https://app.merkur.sh 'self'`) bounds what injected code could reach.

### What ships

Bazel builds the site on Linux x64 (`//tools/bazel/release:site`,
`scripts/build-site-deployment.ts`): the Vite build, `scripts/compress-site.ts` writing
quality-11 Brotli siblings and flagging them in `site-manifest.json`, then
`apps/site/server/build.ts` compiling `apps/site/server/index.ts` into one executable, and it
exports exactly the executable and the page build. The build refuses to start without
`MERKUR_SITE_ORIGIN`, `MERKUR_SITE_API_ORIGIN` and `MERKUR_SITE_RYBBIT_SITE_ID`; the API origin
is compiled into the server too, because the CSP must name the origin the page posts to. The build needs no Rust toolchain and no WebAssembly:
the pages are static markup, and what moves on them is one script and one render worker.

The app host runs it as `merkur-site.service` (`deploy/app/merkur-site.service`), a transient
user with no capabilities listening on loopback for Caddy, from
`/usr/local/lib/merkur/site/<commit>`: root-owned, read-only, only the executable executable.
The `site` environment's SSH key can run one command on that host,
`/usr/local/lib/merkur/install-site` (`scripts/ci/install-site-release.sh`, which the release
installs), so a site deploy can replace the website and nothing else. It takes the commit as
its argument and the exported `site-deployment/` on stdin, refuses a commit already installed
with different bytes, restarts the site, waits for `site_server_started`, and reports the
SHA-512 of the executable it runs, which the workflow requires to be the one it built.

The server reads the manifest at startup, holds every listed file in memory, and answers exact
paths only; nothing it does resolves a URL against the filesystem, and a manifest naming a
missing file stops the start. It proxies Rybbit first-party under `/analytics/` (script,
Web Vitals, track, tracking config), sets no cookie, and forwards no cookie either way.
`PORT`, `RYBBIT_HOST` and `TRUSTED_PROXY_HOPS` are required; `/healthz` answers 204.

The build writes `sitemap.xml` and `robots.txt` for the site origin and puts the structured
data (`Organization`, `WebSite`, `SoftwareApplication`, and a `FAQPage` read from the page's own
questions) into the home page. It also writes `llms.txt` from the built pages: the home page's
description and questions, then every other page under its `og:title` with its description
(`apps/site/src/vite/llms-txt.ts`), so a page needs both. The app server sends
`X-Robots-Tag: noindex` on every response, so only the site's pages are listed.

### One-time setup

1. Authorize the site deploy key on the app host as
   `restrict,command="/usr/local/lib/merkur/install-site" ssh-ed25519 …`, and put its private
   half in the `site` GitHub environment as `SITE_DEPLOY_SSH_KEY`. That environment admits the
   branch `main` only; `production` admits release tags only, and its key reaches the host as
   root.
2. `infra/cloudflare.tf` declares the site's records, proxied, the cache rule that lets the
   edge hold the site's pages, and a token that can only purge the zone's cache:
   `bash scripts/tofu.sh output -raw site_purge_token` goes into the `site` environment as
   `SITE_CLOUDFLARE_PURGE_TOKEN`, and the repository variable `CLOUDFLARE_ZONE_ID` names the
   zone.
3. Add GitHub variables `MERKUR_SITE_ORIGIN` (`https://merkur.sh`) and
   `MERKUR_SITE_RYBBIT_SITE_ID`. The workflow reuses `MERKUR_SERVER_ORIGIN` (the page's API
   origin, `https://app.merkur.sh`).
4. In Rybbit (Analytics below), register `merkur.sh` and turn on First-Party Proxy and User
   ID Salting under the site's Privacy & Security settings, with IP tracking off. The first
   makes it trust the visitor address the proxy sends in `X-Forwarded-For`; the second is
   what the privacy policy's "cannot be linked to you after the day they occur" rests on.
5. In the server's `/etc/merkur/server.env`, set `SITE_ORIGIN=https://merkur.sh`, and to count new waitlist
   addresses `RYBBIT_HOST`, `RYBBIT_SITE_ID` and `RYBBIT_API_KEY` (the README configuration
   table). The key is an organization API key scoped to `ingest:write`; without that scope
   Rybbit treats the event as a visit from the server's own address. The waitlist route
   exists only while `SITE_ORIGIN` is set.
6. After the first deploy, open the site from a known network and confirm Rybbit's realtime
   view places the visit there. A wrong `TRUSTED_PROXY_HOPS` attributes every visitor to one
   proxy's address.
7. Verify `merkur.sh` in Google Search Console and Bing Webmaster Tools by DNS TXT record and
   submit `https://merkur.sh/sitemap.xml` to each.

### Analytics

Rybbit is self-hosted on its own host, analytics-1 (`deploy/analytics/compose.yaml`), from
upstream images at exact versions. Only the dashboard is public, at `https://analytics.merkur.sh` behind
Cloudflare, where Caddy routes `/api/*` and the OAuth discovery paths to the backend and
everything else to the client (`deploy/analytics/Caddyfile`). The site and the app server
reach the backend over the hosts' private network at `http://10.10.0.3:3001`, so a visit never
crosses the internet twice.

| Service | Image | Holds |
| --- | --- | --- |
| `client` | `ghcr.io/rybbit-io/rybbit-client` | The dashboard; it calls `/api` on its own origin |
| `backend` | `ghcr.io/rybbit-io/rybbit-backend` | Ingestion and the dashboard's API, port 3001 |
| `clickhouse` | `clickhouse/clickhouse-server` | Events, under `/var/lib/merkur-analytics/clickhouse` |
| `postgres` | `postgres` | Accounts, sites and API keys |
| `redis` | `redis` | Sessions and identity state; never the app's Dragonfly |

- The backend runs with `DISABLE_TELEMETRY=true`, `DISABLE_SIGNUP=true` and
  `CLUSTER_WORKERS=1`, and `BASE_URL` is the dashboard's public origin. Sign-up is opened only
  to create the first account.
- ClickHouse reads its memory cap, thread limit and disabled system logs from
  `deploy/analytics/clickhouse`; Redis runs with `--appendonly yes --maxmemory-policy
  noeviction`. Secrets live only on the host, in `/etc/merkur-analytics/secrets.env`.
- Upgrading is a new image tag on the backend and the client together; the backend applies
  its own database migrations at start.

### Deploy

A push to `main` deploys the site once its CI run ends green; nothing else is needed. The
workflow deploys only the newest commit of `main`: a CI run that ends after `main` has moved
on, or an old run started again, deploys nothing, and the newest commit's own run does. A
commit whose CI run is red is not deployed, so the site stays on the last green one until a
later commit passes. To deploy the newest commit again by hand:

```sh
gh workflow run deploy-site.yml --ref main
```

The workflow requires a green CI run of the commit, builds the site with Bazel, serves the result locally and records its CSP and the home page's
Brotli entity tag, checks that `/install` answers with the app's installer address, installs
it on the app host, purges both hosts from Cloudflare's cache, then polls production until it
presents that entity tag and the same CSP with `content-encoding: br`. A request without
Brotli must get identity bytes, and the `www.` host must answer with the bare host's address.

To build or package by hand:

```sh
# On Linux x64:
bazel build --config=release //tools/bazel/release:site \
  --//tools/bazel/release:site_origin=https://merkur.sh \
  --//tools/bazel/release:site_api_origin=https://app.merkur.sh \
  "--//tools/bazel/release:site_rybbit_site_id=$SITE_ID"
mkdir site-deployment
tar -xzf "$(bazel info --config=release execution_root)/$(bazel cquery --config=release \
  --output=files //tools/bazel/release:site)" -C site-deployment
```

`bun run test:e2e:site` builds the same pages and server locally and drives them in Chromium:
headers, what a crawler reads without script, the waitlist, the analytics proxy, and that the
page itself asks for no animation frames at rest.

### Deploy order

Cloudflare holds a page for an hour and a hashed asset for a year, and the host serves only
one build. The purge runs only after the new build reports serving: purged any earlier, an
edge would refetch the page from the previous build and keep it for another hour. Between the
switch and the purge, an edge can still hand out the previous page; if it no longer holds that
page's assets, it gets the 404 document for them, cached for a minute. A page opened before
the switch meets the same 404 when it loads its motion and render worker after `load`. The
page reads without script and every picture is a still in the markup until the worker draws,
so what such a visitor sees is the page at rest. The purge covers both hosts entirely, so
unhashed files (`robots.txt`, `sitemap.xml`, `llms.txt`, icons) are fresh after it too.

Carrying the previous build's assets into the new deployment would close that window, but it
needs the previous build's bytes at build time, from the live site or a retained artifact.
That makes every deploy, including the fix for a broken one, depend on the deployment it
replaces, so the site does not do it.
