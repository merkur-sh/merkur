# syntax=mirror.gcr.io/docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Built from the repository root with the same lock and WT patches as the daemon.
# fly deploy --config apps/stun/fly.toml --dockerfile apps/stun/Dockerfile
FROM public.ecr.aws/docker/library/rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97 AS build
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

FROM public.ecr.aws/docker/library/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime
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
