#!/usr/bin/env bash
# Playwright keeps its normal pipe while Chromium uses the native client's network.
set -euo pipefail
exec ip netns exec merkur-natlab-client "${MERKUR_NATLAB_CHROMIUM:?real Chromium path required}" "$@"
