# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# The verifier runs on the build platform.
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

# The dependencies signature verification imports.
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

# The deployment arrives built and signed (`//tools/bazel/release:deployment`, then the release's
# signing); this stage only verifies it before the runtime copies it in.
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
