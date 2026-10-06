# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

# merkur.sh: the static site and the server that serves it.
#
# The file has two halves, used from two places:
#
#   artifacts  CI builds the site from source and exports exactly two things, the
#              server executable and `dist`:
#                docker buildx build -f apps/site/Dockerfile --target artifacts \
#                  --build-arg MERKUR_SITE_ORIGIN=... --build-arg MERKUR_SITE_API_ORIGIN=... \
#                  --build-arg MERKUR_SITE_RYBBIT_SITE_ID=... \
#                  --output type=local,dest=site-deployment .
#   runner     (the default target) packages an exported `site-deployment/` from the
#              build context. The hosting service builds only this stage, from an
#              upload of this file and that directory, so it compiles nothing and
#              serves the bytes CI built and checked.
#
# `apps/site/Dockerfile.dockerignore` replaces the root `.dockerignore` for this
# file: it admits the site's own inputs and the exported directory.

# The build runs on the build platform: the pages are platform-neutral, and
# `apps/site/server/build.ts` cross-targets the server executable from TARGETARCH.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

FROM bun AS dependencies
WORKDIR /app

# Every workspace manifest, or `--frozen-lockfile` refuses the lockfile.
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

RUN bun install --frozen-lockfile

FROM dependencies AS builder
# SECURITY.md carries the release-key fingerprint the security page prints.
COPY tsconfig.base.json SECURITY.md ./
COPY apps/site/ apps/site/
COPY packages/quicksilver/ packages/quicksilver/
COPY packages/logger/ packages/logger/
# Facts the pages state and do not own: the legal text is the app's, and the
# machine limit is the server's.
COPY apps/web/public/legal/ apps/web/public/legal/
COPY apps/server/src/services/machine-usage.ts apps/server/src/services/machine-usage.ts
# The face the terminal marks were cut from; the build checks the cut against it.
COPY apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf
COPY scripts/compress-site.ts scripts/compress-site.ts

# The page and the server are built against the same three facts. None has a
# default here: a build that does not name its origins or its analytics site
# fails in this stage, not in a visitor's browser.
ARG MERKUR_SITE_ORIGIN
ARG MERKUR_SITE_API_ORIGIN
ARG MERKUR_SITE_RYBBIT_SITE_ID
# Read by `apps/site/server/build.ts` to pick the Linux executable.
ARG TARGETARCH
# `--bun`: the image has no Node, and Vite's own entry asks for one.
RUN test -n "$MERKUR_SITE_ORIGIN" \
  && test -n "$MERKUR_SITE_API_ORIGIN" \
  && test -n "$MERKUR_SITE_RYBBIT_SITE_ID" \
  && test -n "$TARGETARCH" \
  && bun --bun run build:site

FROM scratch AS artifacts
COPY --from=builder /app/apps/site/server/dist/site-server /site-server
COPY --from=builder /app/apps/site/dist/ /dist/

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runner

WORKDIR /site

# ca-certificates for the HTTPS upstream (Rybbit); util-linux for setpriv.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 merkur \
  && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin merkur

ENV HOME=/nonexistent

# Root-owned and read-only: the server writes nothing, keeps no state and needs
# no volume. Only the executable carries an execute bit.
COPY --chown=root:root site-deployment/ /site/
RUN find /site -type d -exec chmod 0555 {} + \
  && find /site -type f -exec chmod 0444 {} + \
  && chmod 0555 /site/site-server

# PORT (set by Railway), RYBBIT_HOST and TRUSTED_PROXY_HOPS are required at start.

# Starts as root only long enough to drop to UID/GID 10001 with no capabilities,
# no supplementary groups and `no_new_privs`, exactly as the app server does.
ENTRYPOINT ["/bin/sh", "-ec", "umask 077; exec setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs \"$@\"", "merkur-entrypoint"]
CMD ["/site/site-server", "/site/dist"]
