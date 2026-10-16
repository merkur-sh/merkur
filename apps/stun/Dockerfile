# syntax=mirror.gcr.io/docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Built from the repository root with the same lock and WT patches as the daemon.
# fly deploy --config apps/stun/fly.toml --dockerfile apps/stun/Dockerfile
FROM mirror.gcr.io/library/rust:1.99.1-bookworm@sha256:e12566d5abc17a0da741628782cdb504b68b8961f5bfcf677936bf3e8b32de29 AS build
WORKDIR /build
COPY rust-toolchain.toml ./
COPY .cargo/ .cargo/
COPY Cargo.toml Cargo.lock ./
COPY packages/ packages/
COPY apps/daemon/dataplane/ apps/daemon/dataplane/
COPY apps/stun/ apps/stun/
COPY apps/tui/ apps/tui/
COPY apps/edge/ apps/edge/
RUN cargo build --release --locked -p merkur-stun --bin merkur-stun

FROM mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runtime
# Verification pins the requested certificate; it does not use a public CA store.
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 util-linux \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 merkur \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin merkur
ENV HOME=/nonexistent
COPY --chmod=755 apps/stun/entrypoint.sh /usr/local/bin/merkur-stun-entrypoint
ENTRYPOINT ["/usr/local/bin/merkur-stun-entrypoint"]
CMD ["/usr/local/bin/merkur-stun"]

FROM runtime AS runner
COPY --from=build /build/target/rust/release/merkur-stun /usr/local/bin/merkur-stun
