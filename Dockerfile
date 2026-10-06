# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

# Build tooling runs on the build platform; see the toolchain stage.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

# Shared dependency installation for artifact export and signature verification.
FROM bun AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/daemon/package.json apps/daemon/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/site/package.json apps/site/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/daemon-control-protocol/package.json packages/daemon-control-protocol/package.json
COPY packages/keyboard/package.json packages/keyboard/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/quicksilver/package.json packages/quicksilver/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/user-agent/package.json packages/user-agent/package.json

# Use Docker layer caching: Railway cache mounts require a literal service ID.
RUN bun install --frozen-lockfile

# Everything the builder produces is platform-neutral (WebAssembly, web assets,
# bundled migrations) except the server executable, which `bun build --compile`
# cross-targets. So the toolchain runs on the build platform: the term-wasm
# profile trainer executes SIMD WebAssembly, which an emulated x86-64 JavaScript
# engine refuses. It stays on bookworm, the runner's glibc floor, for the
# native helpers the WebAssembly builds run.
FROM --platform=$BUILDPLATFORM rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97 AS toolchain

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# The profile-guided term-wasm build instruments libzstd's C with clang and
# links it against the Rust-side profile runtime, so clang must be the LLVM the
# pinned Rust uses (22). Bookworm's clang 14 emits registration calls that
# runtime does not define. apt.llvm.org is admitted only under its pinned key.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    brotli \
    ca-certificates \
    curl \
    gnupg \
    pkg-config \
    libssl-dev \
  && curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key -o /tmp/llvm.key \
  && gpg --show-keys --with-colons /tmp/llvm.key | grep -qx 'fpr:::::::::6084F3CF814B57C1CF12EFD515CF4D18AF4F7421:' \
  && gpg --dearmor -o /usr/share/keyrings/llvm.gpg /tmp/llvm.key \
  && echo 'deb [signed-by=/usr/share/keyrings/llvm.gpg] https://apt.llvm.org/bookworm/ llvm-toolchain-bookworm-22 main' \
    > /etc/apt/sources.list.d/llvm-22.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends clang-22 lld-22 llvm-22 \
  && rustup target add wasm32-unknown-unknown \
  && cargo install wasm-pack --version 0.15.0 --locked \
  && rm -rf /var/lib/apt/lists/* /tmp/llvm.key
ENV PATH="/usr/lib/llvm-22/bin:${PATH}"

# `scripts/wasm-toolchain.ts` installs the wasm-bindgen CLI matching Cargo.lock
# the first time a crate is built. Compiling that CLI from source costs ~170s,
# and its only inputs are the version pinned in the lockfile and the toolchain
# channel -- not repository source. Install it against just those two files, so
# the layer is reused until one of them changes; the script then finds the
# pinned version already present and skips the install entirely.
COPY Cargo.lock rust-toolchain.toml ./
RUN version="$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/version = "|"/, ""); print; exit }' Cargo.lock)" \
  && test -n "$version" \
  && cargo install wasm-bindgen-cli --version "$version" --locked --root .tools/wasm-bindgen

# The one ML-DSA-87/SHA-2 implementation, built from this source. The builder
# embeds it in the server; `verified` checks the signed deployment with it, so
# the verifier's cryptography never comes from the bundle it verifies.
FROM toolchain AS e2e-wasm
COPY package.json ./
COPY Cargo.toml ./
COPY .cargo/ .cargo/
COPY apps/ apps/
COPY packages/ packages/
COPY scripts/ scripts/
RUN bun run scripts/build-e2e-wasm.ts

FROM toolchain AS builder
COPY --from=dependencies /app/ /app/
COPY Cargo.toml tsconfig.base.json ./
# The terminal WASM build manifest hashes the pipeline that declares its
# compiler, profile and packaging (`TERM_WASM_BAZEL_PIPELINE_INPUTS`).
COPY .bazelversion .bazelrc MODULE.bazel tsconfig.json ./
COPY tools/bazel/ tools/bazel/
COPY .cargo/ .cargo/
COPY apps/ apps/
COPY packages/ packages/
COPY scripts/ scripts/
COPY --from=e2e-wasm /app/packages/e2e-wasm/pkg/ packages/e2e-wasm/pkg/

ARG VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY
ARG MERKUR_RELEASE_MLDSA87_PUBLIC_KEY
ARG MERKUR_BUILD_COMMIT
# The signed deployment's source commit is also its server/browser version.
ENV MERKUR_VERSION=${MERKUR_BUILD_COMMIT}

RUN bun -e 'import { decodeReleasePublicKey } from "./packages/shared/src/release-signature"; decodeReleasePublicKey(process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? ""); if (!/^[0-9a-f]{40}$/.test(process.env.MERKUR_BUILD_COMMIT ?? "")) throw new Error("MERKUR_BUILD_COMMIT is required")' \
  && bun -e 'const value = process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY ?? ""; const decoded = Buffer.from(value, "base64url"); if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) throw new Error("VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY must be canonical base64url for 32 bytes")' \
  && bun run build:graphics-wasm \
  && bun --no-env-file run --cwd apps/web build
RUN find apps/web/dist -type f ! -name '*.br' -print0 \
  | xargs -0 -r -n 1 -P "$(nproc)" brotli --force --quality=11
# `bun build` inlines `process.env.NODE_ENV` while bundling — as "development"
# unless the build itself says otherwise — so the executable never reads the
# deployment's runtime variable. Production HSTS, `upgrade-insecure-requests`
# and the loopback-origin cookie relaxation all key on this constant.
# `--conditions=workerd` resolves `@libsql/client` to its pure-JavaScript build.
# The default Node build reaches for a native `.node` addon, which `--compile`
# cannot embed and the signed runtime has no `node_modules` to hold; selecting
# the network client here is what makes a standalone binary possible at all, and
# it is why a `file:` database URL is refused in production rather than quietly
# opening a file on the container's disk.
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) bun_target=bun-linux-x64 ;; \
      arm64) bun_target=bun-linux-arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && mkdir -p apps/server/dist \
  && bun build apps/server/src/index.ts --target "${bun_target}" --compile --conditions=workerd --outfile apps/server/dist/server \
    --define "process.env.NODE_ENV=\"production\"" \
    --define "process.env.MERKUR_BUILD_ID=$(bun -e 'process.stdout.write(JSON.stringify(JSON.parse(await Bun.file("apps/web/dist/merkur-build.json").text()).buildId))')" \
    --define "process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY=\"${MERKUR_RELEASE_MLDSA87_PUBLIC_KEY}\"" \
    --define "process.env.MERKUR_VERSION=\"${MERKUR_VERSION}\"" \
    --define "process.env.MERKUR_OPAQUE_WEB_BUILD_PUBLIC_KEY=\"${VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY}\""

# Migrations are loaded after the compiled server starts. Bundle their runtime
# imports too: the signed runtime intentionally has no node_modules directory.
RUN bun build apps/server/migrations/*.ts --target bun --root apps/server/migrations --outdir /app/migrations-built

# Export exact bytes, sign offline, then package using the default target.
FROM scratch AS artifacts
COPY --from=builder /app/apps/server/dist/ /server/
COPY --from=builder /app/migrations-built/ /migrations/
COPY --from=builder /app/apps/web/dist/ /web/

FROM dependencies AS verified
ARG MERKUR_RELEASE_MLDSA87_PUBLIC_KEY
ARG MERKUR_BUILD_COMMIT
COPY packages/shared/src/ packages/shared/src/
COPY --from=e2e-wasm /app/packages/e2e-wasm/pkg/ packages/e2e-wasm/pkg/
COPY scripts/web-build-signature.ts scripts/web-build-signature.ts
COPY deployment/ deployment/
RUN bun run deployment:verify -- --directory deployment --commit "$MERKUR_BUILD_COMMIT"

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 merkur \
  && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin merkur

ENV HOST=0.0.0.0
ENV HOME=/nonexistent

# Optional at deploy/runtime: TURN_HOST/TURN_SECRET enable coturn support.
# TURN_PROVIDER=cloudflare with CLOUDFLARE_TURN_KEY_ID/CLOUDFLARE_TURN_API_TOKEN
# enables Cloudflare Realtime TURN support.

EXPOSE 3000

# The database is a separate service reached over the network, so this image
# owns no persistent state and needs no volume to repair the ownership of.
ENTRYPOINT ["/bin/sh", "-ec", "umask 077; exec setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs \"$@\"", "merkur-entrypoint"]
CMD ["/deployment/server/server"]

FROM runtime AS runner
COPY --from=verified --chown=root:root /app/deployment/ /deployment/
COPY --from=verified --chown=root:root /app/deployment/migrations/ /migrations/
# Normalize unsigned mode bits as well as ownership; only the server is executable.
RUN find /deployment /migrations -type d -exec chmod 0555 {} + \
  && find /deployment /migrations -type f -exec chmod 0444 {} + \
  && chmod 0555 /deployment/server/server
