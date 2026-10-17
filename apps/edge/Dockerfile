# syntax=mirror.gcr.io/docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
#
# The edge's runtime image, built from the REPO ROOT around the release binary Bazel builds from
# the one workspace lockfile the gates test:
#
#   bazel run --config=release //tools/bazel/release:image_binaries
#   docker buildx build --platform linux/amd64 -f apps/edge/Dockerfile .
#
# The binary is Linux x86_64, so the release workflow builds it, and the image, on a Linux x86_64
# runner; `bun run edge:fly-config render <edge-id> <version>` writes the Fly config it deploys with.
FROM mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux iproute2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 merkur \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin merkur \
    && mkdir -p /data \
    && chown 10001:10001 /data \
    && chmod 0700 /data
ENV MERKUR_EDGE_PORT=4433 MERKUR_EDGE_IDENTITY_DIR=/data/identity RUST_LOG=info HOME=/nonexistent
EXPOSE 4433/udp
# Root only long enough to cap egress with `tc` and repair the identity volume's
# ownership; no network service starts until all capabilities and supplementary
# groups are dropped. See apps/edge/entrypoint.sh.
COPY apps/edge/entrypoint.sh /usr/local/bin/merkur-edge-entrypoint
ENTRYPOINT ["/usr/local/bin/merkur-edge-entrypoint"]
CMD ["/usr/local/bin/merkur-edge"]
COPY --chmod=755 dist/images/merkur-edge /usr/local/bin/merkur-edge
