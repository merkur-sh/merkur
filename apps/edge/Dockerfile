# syntax=mirror.gcr.io/docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# Built from the REPO ROOT, not from apps/edge.
#
# The edge used to compile standalone from its own committed Cargo.lock, with a
# build context of apps/edge alone. That was pleasant but unsound: two lockfiles
# described the same binary, nothing compared them, and the workspace gates
# therefore tested a dependency graph that production need not have shared. It
# became untenable with `[patch.crates-io]`, which lives in the workspace root
# and is invisible to a standalone build -- the gates would have exercised a
# patched wtransport while Fly ran the registry one, silently.
#
# One lockfile now describes the edge whether cargo or Fly builds it. The cost
# is that every Rust change in the workspace invalidates this image's cache,
# which is the honest price of the binary and the gates agreeing.
#
# Deploy from the repo root, NOT from this directory:
#   bun run edge:fly-config render <edge-id> <version>
#   fly deploy --config apps/edge/fly/<edge-id>.toml --dockerfile apps/edge/Dockerfile
FROM public.ecr.aws/docker/library/rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97 AS build
WORKDIR /build

# The pinned toolchain and cargo config, so the image compiles with the same
# rustc AND the same resolver settings the gates do. `.cargo/config.toml` also
# redirects the target directory to `target/rust`, which is why the artifact is
# copied from there below rather than from cargo's default `target/`.
COPY rust-toolchain.toml ./
COPY .cargo/ .cargo/

# `--locked` is what makes an unreviewed dependency bump a build failure instead
# of a silent update: without the lock, cargo re-resolves at image build time and
# the binary running in production is not the one any gate ever compiled.
COPY Cargo.toml Cargo.lock ./

# Every workspace member, because cargo parses all of them to resolve any one.
# `packages/alacritty-terminal-patch/tests` is 46MB of upstream ref fixtures and
# is excluded by .dockerignore; cargo does not need it to build another member.
COPY packages/ packages/
COPY apps/daemon/dataplane/ apps/daemon/dataplane/
COPY apps/stun/ apps/stun/
COPY apps/tui/ apps/tui/
COPY apps/edge/ apps/edge/

RUN cargo build --release --locked -p merkur-edge --bin merkur-edge

FROM public.ecr.aws/docker/library/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime
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

FROM runtime AS runner
COPY --from=build /build/target/rust/release/merkur-edge /usr/local/bin/merkur-edge
