# syntax=mirror.gcr.io/docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The STUN responder's runtime image, built from the repository root around the release binary
# Bazel builds (`bazel run --config=release //tools/bazel/release:image_binaries`), on a Linux
# x86_64 runner like the binary.
FROM mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
# Verification pins the requested certificate; it does not use a public CA store.
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 util-linux \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 merkur \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin merkur
ENV HOME=/nonexistent
COPY --chmod=755 apps/stun/entrypoint.sh /usr/local/bin/merkur-stun-entrypoint
ENTRYPOINT ["/usr/local/bin/merkur-stun-entrypoint"]
CMD ["/usr/local/bin/merkur-stun"]
COPY --chmod=755 dist/images/merkur-stun /usr/local/bin/merkur-stun
