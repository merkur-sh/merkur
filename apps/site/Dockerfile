# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# merkur.sh: the static site and the server that serves it.
#
# The image packages an exported `site-deployment/` from the build context: the server
# executable and `dist`, which Bazel builds on Linux x64 (`//tools/bazel/release:site`). The
# hosting service builds this file from an upload of it and that directory, so it compiles
# nothing and serves the bytes CI built and checked. `apps/site/Dockerfile.dockerignore`
# replaces the root `.dockerignore` for this file and admits only that directory.
FROM mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

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
