#!/usr/bin/env bash
# The build context Railway builds the server image from (`Dockerfile`): the release commit's
# tracked files, the signed deployment, and the e2e WebAssembly package the image's signature
# check imports, which Git ignores and `bazel run //tools/bazel/wasm:sync` writes.
# `railway_context_test.py` holds the Dockerfile's every copied source to this list.
set -euo pipefail
context="${1:?usage: railway-context.sh <empty directory>}"
: "${COMMIT:?}"
mkdir "$context"
git archive "$COMMIT" | tar -x -C "$context"
cp -R deployment "$context/deployment"
mkdir -p "$context/packages/e2e-wasm"
cp -R packages/e2e-wasm/pkg "$context/packages/e2e-wasm/pkg"
