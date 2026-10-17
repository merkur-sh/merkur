#!/usr/bin/env bash
# Runs OpenTofu on infra/ with every credential from the macOS Keychain:
# `bash scripts/tofu.sh plan`, `bash scripts/tofu.sh apply`.
set -euo pipefail
secret() { security find-generic-password -a merkur -s "$1" -w; }
AWS_ACCESS_KEY_ID=$(secret r2-state-access)
AWS_SECRET_ACCESS_KEY=$(secret r2-state-secret)
TF_VAR_state_passphrase=$(secret tofu-state-passphrase)
TF_VAR_hcloud_token=$(secret hcloud)
TF_VAR_cloudflare_api_token=$(secret cloudflare-api-token)
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY TF_VAR_state_passphrase TF_VAR_hcloud_token \
  TF_VAR_cloudflare_api_token
exec tofu -chdir="$(dirname "$0")/../infra" "$@"
