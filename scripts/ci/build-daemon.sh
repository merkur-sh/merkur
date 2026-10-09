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
  docker buildx build --platform "$DOCKER_PLATFORM" --file Dockerfile.daemon-release \
    --target smoke-runtime --load --tag merkur-daemon-smoke:release .
  docker run --rm --pull never --platform "$DOCKER_PLATFORM" -v "$PWD:/work:ro" merkur-daemon-smoke:release \
    python3 /work/scripts/ci/release_smoke.py /work/dist/smoke "$VERSION" "$SEQUENCE" -
else
  MERKUR_PUBLIC_ORIGIN="$SERVER_ORIGIN" MERKUR_OPAQUE_SERVER_PUBLIC_KEY="$OPAQUE_PIN" \
    bun run scripts/build-daemon-dist.ts --version "$VERSION" --sequence "$SEQUENCE" --platform "$PLATFORM"
  COPYFILE_DISABLE=1 tar --format=ustar --no-xattrs -czf "dist/ci-release/merkur-daemon-$PLATFORM.tar.gz" \
    -C apps/daemon/dist merkur merkur-dataplane merkur-image-worker merkur-tui
  python3 scripts/ci/release_smoke.py apps/daemon/dist "$VERSION" "$SEQUENCE" -
fi
