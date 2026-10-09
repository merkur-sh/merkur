# Release Signing

Merkur's daemon release trust chain uses a canonical manifest signed with ML-DSA-87 under the fixed
FIPS 204 context `merkur-release-manifest`. There is no algorithm identifier, key identifier,
legacy signature reader, unsigned checksum mode, or verification fallback.

Web and deployment bundles use the same CI-held release key with separate FIPS 204 contexts:
`merkur-web-release-manifest` and `merkur-deployment-release-manifest`. Docker verifies
the complete signed bundle before packaging it. Only the protected signing job receives the seed.

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
above with explicit public inputs; Docker uses that same boundary.

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
browser first-load trust or protect assets modified after verification. Docker enforces
the separate deployment verification step below. Keep the seed off build hosts and the application server.

## Signed Docker Deployment

The default Docker target packages a finished signed directory named `deployment` at the
repository root. It never rebuilds signed files. The `artifacts` target exports the Linux
server executable, migrations, and finished web assets (including Brotli copies) for CI
signing. Select the production platform explicitly (`linux/amd64` for the hosted server).

```sh
DEPLOYMENT_COMMIT=$(git rev-parse HEAD)
: "${MERKUR_RELEASE_MLDSA87_PUBLIC_KEY:?set the trusted release public-key pin}"
: "${OPAQUE_SERVER_PUBLIC_KEY:?set the deployed OPAQUE public-key pin}"
export MERKUR_RELEASE_MLDSA87_PUBLIC_KEY

# Export into a fresh directory. No signing seed enters the Docker context.
docker buildx build --platform linux/amd64 --target artifacts \
  --build-arg "MERKUR_BUILD_COMMIT=$DEPLOYMENT_COMMIT" \
  --build-arg "MERKUR_RELEASE_MLDSA87_PUBLIC_KEY=$MERKUR_RELEASE_MLDSA87_PUBLIC_KEY" \
  --build-arg "VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY=$OPAQUE_SERVER_PUBLIC_KEY" \
  --output type=local,dest=deployment .

# In the isolated signing job, sign the web files first, then the
# complete deployment, which also binds the web manifest and detached signature.
bun run web:sign -- --directory deployment/web --commit "$DEPLOYMENT_COMMIT" \
  --seed-file "$SEED_FILE"
bun run deployment:sign -- --directory deployment --commit "$DEPLOYMENT_COMMIT" \
  --seed-file "$SEED_FILE"

# Return only the signed bundle to the packaging host, at repository-root deployment/.
bun run deployment:verify -- --directory deployment --commit "$DEPLOYMENT_COMMIT"
docker buildx build --platform linux/amd64 --load \
  --build-arg "MERKUR_BUILD_COMMIT=$DEPLOYMENT_COMMIT" \
  --build-arg "MERKUR_RELEASE_MLDSA87_PUBLIC_KEY=$MERKUR_RELEASE_MLDSA87_PUBLIC_KEY" \
  -t merkur .
```

The deployment commands default to `deployment`. Signing creates
`merkur-deployment-release.json` and `merkur-deployment-release.sig`, refusing overwrites.
The manifest covers every file in the bundle except those two root proof files. Verification
checks both signatures, the expected commit, and the exact file sets. A non-empty server
executable and migration set are required. Missing, changed, additional, or unsigned files
fail packaging. The final image runs as `merkur`; signed files are root-owned and read-only
under `/deployment`, with the identical signed migrations copied to `/migrations`.

All Docker base images and the Dockerfile frontend are pinned by multi-platform digest.
Rust and Debian images are pulled from Docker's official Amazon ECR Public repositories.
The Rust builders use the official pinned Debian 12 Rust image, without executing a downloaded
installer; `wasm-pack` is pinned to 0.15.0 and the wasm-bindgen CLI to the version `Cargo.lock`
resolves, both built from source with locked dependencies. Review and refresh these
pins when publishing security updates. Digest pinning does not automatically update old images,
and APT packages still come from Debian's authenticated repositories at build time. Rebuild and
scan the final images when OS advisories require updates; application signatures do not cover
the base OS, shared libraries, or entrypoint.

The root `.dockerignore` admits only the declared source/configuration inputs and the complete
signed deployment directory. Artifact builders copy source directories explicitly, so a previous
deployment is never incorporated into a new build. Keep signing keys outside the checkout.
Do not filter extra files inside the signed directory: the verifier must see and reject them.

The server Dockerfile uses ordinary Docker layer caching without cache mounts, which keeps the
recipe portable across services and builders. Unchanged layers remain reusable;
changes that invalidate a build layer rebuild it without a separate persistent compiler cache.

The edge entrypoint starts as root only to repair ownership of its mounted `/data` directory,
without following symlinks, then executes the service as UID/GID 10001. The server has no
mounted directory to repair -- its database is a separate service -- so it starts as root only
long enough to drop to the same UID/GID. Both clear supplementary groups and inheritable,
ambient, and bounding capabilities, and set the irreversible `no_new_privs` bit. They use an owner-only creation mask and have no writable home directory.
The application directory stays root-owned. STUN starts directly as UID/GID 10001 and sets
`no_new_privs`. The server package normalizes directory modes to 0555, file modes to 0444,
and its executable to 0555; supplied setuid/setgid modes do not survive packaging.

Production server deployment is a stage of the tag-triggered release workflow. The hosting
service never builds from its own Git source: a plain Git checkout lacks the signed bundle.
CI uploads a clean checkout plus that signed directory, and the default Docker target verifies
and packages those bytes. Runtime variables, volume, port, and readiness settings stay on the
service. Retain the exact local signed bundle so rollout checks can compare it with production:

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
seed, and retains exact bytes before production changes. It deploys the server and edge, then
publishes the daemon assets. See [CI operations](ci.md).

### Runtime filesystem restrictions

For Docker hosting, `docker-compose.production.yaml` enforces a read-only root filesystem,
`no-new-privileges`, and a minimal initialization capability set. The entrypoint drops that
entire set before starting the server. Only `/data` and a `nosuid,nodev,noexec` temporary
filesystem at `/tmp` are writable. It binds port 3000 to loopback for a TLS reverse proxy;
provision Redis/Dragonfly separately and configure its URL in the runtime environment file.

```sh
export MERKUR_IMAGE_REPOSITORY=registry.example.com/your-org/merkur
# Exactly the 64 hexadecimal digest characters from the trusted release record.
export MERKUR_IMAGE_SHA256=your_verified_image_digest
export MERKUR_RUNTIME_ENV_FILE=/secure/runtime/merkur.env
docker compose -f docker-compose.production.yaml up -d
```

The runtime environment file must contain the production server configuration and remain
outside the checkout. The digest and environment-file path are required; Compose has no
default image tag or bundled credentials. The server keeps no
durable state of its own: its database is a separate libSQL service reached through `DB_URL`,
so the server container needs no volume. Use the same read-only root and capability policy
for an independently hosted edge, keeping its identity volume writable at `/data`. STUN
needs no persistent writable storage and can run with all capabilities dropped.

Hosted platforms run their own container configurations; this Compose file does not
configure them. The image entrypoints enforce the privilege drop everywhere, but
filesystem mount restrictions must be enforced by the hosting platform. Do not describe
a production root filesystem as read-only without verifying its actual mount settings.
Keep the default entrypoint: replacing it bypasses its initialization and restrictions.

The Debian Bookworm runtime image runs as the non-root `merkur` user, exposes port `3000`, holds no
persistent state, and starts `/deployment/server/server`.

### Settings Verification ID

Each web build emits a fresh build marker, embedded in the client and compiled into its
server. The server checks the signed proofs before opening HTTP and exposes them through
an uncached `/api/build-identity` response. Source development serves `null`.

The Docker artifact build sets `MERKUR_VERSION` to the required `MERKUR_BUILD_COMMIT`
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

A release build (a `vX.Y.Z` version) ships a profile-guided `merkur-dataplane`;
`build-daemon-dist.ts` passes `--pgo` to `build-daemon-artifacts.ts`, which builds an
instrumented dataplane test binary, trains it on the unit suite (for breadth) and the display
pipeline and scroll benchmarks (for weights), merges the profile with the `llvm-profdata` from
rustup's `llvm-tools` component (listed in `rust-toolchain.toml`, so it matches rustc's LLVM),
and rebuilds the dataplane with it. Training executes the target's own binary on the build
machine: CI builds every platform natively, a `darwin-x64` build on Apple Silicon trains under
Rosetta, and the Linux container trains as root. Development builds skip it.

## Build macOS

CI builds `darwin-arm64` on Apple Silicon and `darwin-x64` on native Intel runners.
The native runners smoke-test all four executables, including helper confinement. `SEQUENCE` is a positive monotonic security counter and must never be reused, even when a
release is withdrawn.

```sh
: "${VERSION:?set VERSION to the exact vMAJOR.MINOR.PATCH tag}"
: "${SEQUENCE:?set SEQUENCE to the new monotonic release sequence}"
: "${MERKUR_RELEASE_MLDSA87_PUBLIC_KEY:?set the trusted release public-key pin}"
: "${MERKUR_PUBLIC_ORIGIN:?set the canonical HTTPS account origin}"
: "${MERKUR_OPAQUE_SERVER_PUBLIC_KEY:?set the trusted account OPAQUE pin}"
export MERKUR_PUBLIC_ORIGIN MERKUR_OPAQUE_SERVER_PUBLIC_KEY

bun install --frozen-lockfile
bun run scripts/build-daemon-dist.ts --version "$VERSION" --sequence "$SEQUENCE" --platform darwin-arm64
test "$(apps/daemon/dist/merkur version)" = "$VERSION"
COPYFILE_DISABLE=1 tar --format=ustar --no-xattrs \
  -czf merkur-daemon-darwin-arm64.tar.gz \
  -C apps/daemon/dist merkur merkur-dataplane merkur-image-worker merkur-tui

bun run scripts/build-daemon-dist.ts --version "$VERSION" --sequence "$SEQUENCE" --platform darwin-x64
test "$(apps/daemon/dist/merkur version)" = "$VERSION"
COPYFILE_DISABLE=1 tar --format=ustar --no-xattrs \
  -czf merkur-daemon-darwin-x64.tar.gz \
  -C apps/daemon/dist merkur merkur-dataplane merkur-image-worker merkur-tui
```

## Build Linux

Linux releases retain the Debian 12 (glibc 2.36) ABI floor. The container build must receive the
same version, sequence, and public pin used by the macOS build; the release build should fail if any
is absent. Build both architectures with the checked-in container recipe, then smoke-run all four
executables on clean matching Debian 12 containers before signing. The image worker must emit its
READY marker under an empty environment, after entering confinement and before reading image data.

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --file Dockerfile.daemon-release \
  --target artifacts \
  --build-arg "MERKUR_VERSION=$VERSION" \
  --build-arg "MERKUR_PUBLIC_ORIGIN=$MERKUR_PUBLIC_ORIGIN" \
  --build-arg "MERKUR_OPAQUE_SERVER_PUBLIC_KEY=$MERKUR_OPAQUE_SERVER_PUBLIC_KEY" \
  --build-arg "MERKUR_RELEASE_SEQUENCE=$SEQUENCE" \
  --build-arg "MERKUR_RELEASE_MLDSA87_PUBLIC_KEY=$MERKUR_RELEASE_MLDSA87_PUBLIC_KEY" \
  --output type=local,dest=dist/release-linux,platform-split=false \
  .
```

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

The public site is `apps/site`, served by its own Railway service behind Railway's CDN at
`https://merkur.sh`; `www.merkur.sh` is attached to the same service and answers every path
with a 308 to the bare host. The app is a different origin, `https://app.merkur.sh`: Railway
maps a custom domain to one service and cannot route by path, and the app's origin is bound
into OPAQUE and delegation. The site answers one path on the app's behalf, `/install`, with a
308 to the app's installer, so `curl -fsSL merkur.sh/install | sh` works as the page prints it.
[Deploy site](../.github/workflows/deploy-site.yml) runs for each commit of `main` whose CI
run ends green, and can be dispatched by hand. The app is released only by a tag.

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

`apps/site/Dockerfile` has two halves. Its `artifacts` target builds from source (the Vite
build, `scripts/compress-site.ts` writing quality-11 Brotli siblings and flagging them in
`site-manifest.json`, then `apps/site/server/build.ts` compiling `apps/site/server/index.ts`
into one executable) and exports exactly the executable and the page build. The builder
refuses to start without `MERKUR_SITE_ORIGIN`, `MERKUR_SITE_API_ORIGIN` and
`MERKUR_SITE_RYBBIT_SITE_ID`; the API origin is compiled into the server too, because the CSP
must name the origin the page posts to. The build needs no Rust toolchain and no WebAssembly:
the pages are static markup, and what moves on them is one script and one render worker.

The default `runner` target packages an exported `site-deployment/` directory from its build
context, root-owned and read-only, and starts the server as UID/GID 10001 through the same
`setpriv` entrypoint as the app. Railway builds only that stage, from an upload of the
Dockerfile, its `apps/site/Dockerfile.dockerignore` and the exported bytes, so it compiles
nothing and serves exactly what the workflow tested.

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

1. Create an empty service in the production project and environment, with its variables.
   `TRUSTED_PROXY_HOPS` means what it means on the server service: the proxies that append
   to `X-Forwarded-For` in front of this one.

   ```sh
   railway add --service site \
     --variables PORT=8080 \
     --variables RYBBIT_HOST=https://app.rybbit.io \
     --variables TRUSTED_PROXY_HOPS=1 \
     --variables RAILWAY_DOCKERFILE_PATH=apps/site/Dockerfile
   ```

   Set the service's healthcheck path to `/healthz` in its settings.
2. Attach both domains and add the DNS records they print:
   `railway domain merkur.sh --service site --port 8080`, then the same for `www.merkur.sh`.
3. Enable the CDN. HTML caching stays `auto`: every response carries its own directive, so
   the server's headers decide what is cached and the default TTL never applies. Purging HTML
   on deploy covers rollbacks and dashboard redeploys; the workflow purges again itself.

   ```sh
   railway cdn enable --service site
   railway cdn update --service site --html-caching auto --swr --purge-on-deploy html
   ```

4. Add GitHub variables `RAILWAY_SITE_SERVICE_ID`, `MERKUR_SITE_ORIGIN`
   (`https://merkur.sh`) and `MERKUR_SITE_RYBBIT_SITE_ID`. The workflow reuses
   `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID` and `MERKUR_SERVER_ORIGIN` (the page's API
   origin, `https://app.merkur.sh`). Create the `site` GitHub environment with the branch
   deployment policy `main` and its own `RAILWAY_TOKEN`, scoped to this service: the
   `production` environment admits release tags only, and its token reaches the app.
5. In Rybbit, register `merkur.sh` and turn on First-Party Proxy under the site's Privacy
   & Security settings, so it trusts the visitor address the proxy sends in `X-Forwarded-For`.
6. On the server service, set `SITE_ORIGIN=https://merkur.sh`, and to count new waitlist
   addresses `RYBBIT_HOST`, `RYBBIT_SITE_ID` and `RYBBIT_API_KEY` (the README configuration
   table). The waitlist route exists only while `SITE_ORIGIN` is set.
7. After the first deploy, open the site from a known network and confirm Rybbit's realtime
   view places the visit there. A wrong `TRUSTED_PROXY_HOPS` attributes every visitor to one
   proxy's address.
8. Verify `merkur.sh` in Google Search Console and Bing Webmaster Tools by DNS TXT record and
   submit `https://merkur.sh/sitemap.xml` to each.

### Deploy

A push to `main` deploys the site once its CI run ends green; nothing else is needed. The
workflow deploys only the newest commit of `main`: a CI run that ends after `main` has moved
on, or an old run started again, deploys nothing, and the newest commit's own run does. A
commit whose CI run is red is not deployed, so the site stays on the last green one until a
later commit passes. To deploy the newest commit again by hand:

```sh
gh workflow run deploy-site.yml --ref main
```

The workflow requires a green CI run of the commit, builds the `artifacts` target with a
GitHub Actions cache, serves the result locally and records its CSP and the home page's
Brotli entity tag, checks that `/install` answers with the app's installer address, uploads,
waits for Railway to report `SUCCESS`, purges the CDN's HTML, then polls production until it
presents that entity tag and the same CSP with `content-encoding: br`. A request without
Brotli must get identity bytes, which proves the CDN keys its cache on `Accept-Encoding`, and
the `www.` host must answer with the bare host's address. The workflow pins Railway CLI
5.62.1; the release workflow's 5.12.1 predates `railway cdn`.

To build or package by hand:

```sh
docker buildx build -f apps/site/Dockerfile --target artifacts --platform linux/amd64 \
  --build-arg MERKUR_SITE_ORIGIN=https://merkur.sh \
  --build-arg MERKUR_SITE_API_ORIGIN=https://app.merkur.sh \
  --build-arg MERKUR_SITE_RYBBIT_SITE_ID="$SITE_ID" \
  --output type=local,dest=site-deployment .
docker buildx build -f apps/site/Dockerfile --platform linux/amd64 --load -t merkur-site .
```

`bun run test:e2e:site` builds the same pages and server locally and drives them in Chromium:
headers, what a crawler reads without script, the waitlist, the analytics proxy, and that the
page itself asks for no animation frames at rest.

### Deploy order

The CDN holds a page for an hour and a hashed asset for a year, and each container serves only
its own build. The purge runs only after Railway reports `SUCCESS`: purged any earlier, an edge
would refetch the page from the previous container and keep it for another hour. Between the
switch and the purge, an edge can still hand out the previous page; if it no longer holds that
page's assets, it gets the 404 document for them, cached for a minute. A page opened before
the switch meets the same 404 when it loads its motion and render worker after `load`. The
page reads without script and every picture is a still in the markup until the worker draws,
so what such a visitor sees is the page at rest. Unhashed files other than HTML (`robots.txt`,
`sitemap.xml`, `llms.txt`, icons) are not in an HTML purge and can stay an hour stale.

Carrying the previous build's assets into the new image would close that window, but it needs
the previous build's bytes at build time, from the live site or a retained artifact. That
makes every deploy, including the fix for a broken one, depend on the deployment it replaces,
so the site does not do it.
