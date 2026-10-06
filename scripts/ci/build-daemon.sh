#!/usr/bin/env bash
set -euo pipefail
mkdir -p dist/ci-release dist/smoke
if [[ "$PLATFORM" == linux-* ]]; then
  docker buildx build --platform "$DOCKER_PLATFORM" --file Dockerfile.daemon-release \
    --target artifacts --build-arg "MERKUR_VERSION=$VERSION" \
    --build-arg "MERKUR_PUBLIC_ORIGIN=$SERVER_ORIGIN" \
    --build-arg "MERKUR_OPAQUE_SERVER_PUBLIC_KEY=$OPAQUE_PIN" \
    --build-arg "MERKUR_RELEASE_SEQUENCE=$SEQUENCE" \
    --build-arg "MERKUR_RELEASE_MLDSA87_PUBLIC_KEY=$MERKUR_RELEASE_MLDSA87_PUBLIC_KEY" \
    --output type=local,dest=dist/ci-release .
  tar -xzf "dist/ci-release/merkur-daemon-$PLATFORM.tar.gz" -C dist/smoke
  docker run --rm --platform "$DOCKER_PLATFORM" -v "$PWD:/work:ro" debian:12-slim \
    sh -ec 'apt-get update -qq; apt-get install -y -qq python3; python3 /work/scripts/ci/release_smoke.py /work/dist/smoke "$1" "$2" -' sh "$VERSION" "$SEQUENCE"
else
  MERKUR_PUBLIC_ORIGIN="$SERVER_ORIGIN" MERKUR_OPAQUE_SERVER_PUBLIC_KEY="$OPAQUE_PIN" \
    bun run scripts/build-daemon-dist.ts --version "$VERSION" --sequence "$SEQUENCE" --platform "$PLATFORM"
  COPYFILE_DISABLE=1 tar --format=ustar --no-xattrs -czf "dist/ci-release/merkur-daemon-$PLATFORM.tar.gz" \
    -C apps/daemon/dist merkur merkur-dataplane merkur-image-worker merkur-tui
  python3 scripts/ci/release_smoke.py apps/daemon/dist "$VERSION" "$SEQUENCE" -
fi
