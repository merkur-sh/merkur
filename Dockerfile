# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# Build tooling runs on the build platform; see the builder stage.
FROM --platform=$BUILDPLATFORM mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS bun
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libatomic1 unzip \
  && case "$(dpkg --print-architecture)" in \
    amd64) build=x64-baseline; digest=1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b ;; \
    arm64) build=aarch64; digest=efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21 ;; \
    *) echo "unsupported Bun architecture" >&2; exit 1 ;; \
  esac \
  && curl --fail --silent --show-error --location "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-$build.zip" -o /tmp/bun.zip \
  && printf '%s  /tmp/bun.zip\n' "$digest" | sha256sum --check \
  && unzip -p /tmp/bun.zip "bun-linux-$build/bun" > /usr/local/bin/bun \
  && chmod 0755 /usr/local/bin/bun \
  && ln -s bun /usr/local/bin/bunx \
  && ln -s bun /usr/local/bin/node \
  && test "$(bun --version)" = 1.4.3 \
  && case "$(dpkg --print-architecture)" in \
    amd64) pnpm=linux-x64; pnpm_digest=b0c9673be13d4b914b8045a56986418c55c446bb8d113b65ec65bf7cb7bec35f ;; \
    arm64) pnpm=linux-arm64; pnpm_digest=f41d5272bdc1d07139daa31412d24bd5394476a4b8b6eb72c269d3bd52e95d4a ;; \
  esac \
  && curl --fail --silent --show-error --location "https://github.com/pnpm/pnpm/releases/download/v11.28.3/pnpm-$pnpm.tar.gz" -o /tmp/pnpm.tgz \
  && printf '%s  /tmp/pnpm.tgz\n' "$pnpm_digest" | sha256sum --check \
  && mkdir -p /opt/pnpm \
  && tar -xzf /tmp/pnpm.tgz -C /opt/pnpm \
  && ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm \
  && test "$(pnpm --version)" = 11.28.3 \
  && rm -rf /tmp/bun.zip /tmp/pnpm.tgz /var/lib/apt/lists/*
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 BUN_INSTALL_BIN=/usr/local/bin

# Shared dependency installation for artifact export and signature verification.
FROM bun AS dependencies
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
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
RUN pnpm install --frozen-lockfile

# Everything the builder produces is platform-neutral (web assets, bundled migrations) except
# the server executable, which `bun build --compile` cross-targets, so it runs on the build
# platform. The WebAssembly packages arrive built: Bazel builds them before the image does
# (`bun run build:wasm`).
FROM dependencies AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends brotli \
  && rm -rf /var/lib/apt/lists/*
COPY tsconfig.base.json tsconfig.json ./
COPY apps/ apps/
COPY packages/ packages/
COPY scripts/ scripts/

ARG VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY
ARG MERKUR_RELEASE_MLDSA87_PUBLIC_KEY
ARG MERKUR_BUILD_COMMIT
# The signed deployment's source commit is also its server/browser version.
ENV MERKUR_VERSION=${MERKUR_BUILD_COMMIT}

RUN bun -e 'import { decodeReleasePublicKey } from "./packages/shared/src/release-signature"; decodeReleasePublicKey(process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? ""); if (!/^[0-9a-f]{40}$/.test(process.env.MERKUR_BUILD_COMMIT ?? "")) throw new Error("MERKUR_BUILD_COMMIT is required")' \
  && bun -e 'const value = process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY ?? ""; const decoded = Buffer.from(value, "base64url"); if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) throw new Error("VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY must be canonical base64url for 32 bytes")' \
  && bun --no-env-file run --cwd apps/web vite build
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
COPY packages/e2e-wasm/pkg/ packages/e2e-wasm/pkg/
COPY scripts/web-build-signature.ts scripts/web-build-signature.ts
COPY deployment/ deployment/
RUN bun run deployment:verify -- --directory deployment --commit "$MERKUR_BUILD_COMMIT"

FROM mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runtime

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
