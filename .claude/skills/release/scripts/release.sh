#!/usr/bin/env bash
# Human entry point: CI owns every build, signature, deployment and rollout.
set -euo pipefail
command=${1:-}
version=${2:-}
[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo 'usage: release.sh trigger|watch vMAJOR.MINOR.PATCH' >&2
  exit 2
}
case "$command" in
  trigger)
    git diff --quiet
    git diff --cached --quiet
    git fetch origin main --no-tags
    commit=$(git rev-parse HEAD)
    test "$commit" = "$(git rev-parse FETCH_HEAD)"
    repository=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
    gh api "repos/$repository/actions/workflows/ci.yml/runs?head_sha=$commit&event=push&status=success" \
      --jq '.workflow_runs[] | select(.head_branch == "main") | .id' | grep -q .
    git tag -a "$version" -m "$version"
    git push origin "refs/tags/$version"
    ;;
  watch)
    run_id=$(gh run list --workflow release.yml --branch "$version" --json databaseId --jq '.[0].databaseId')
    test -n "$run_id" && test "$run_id" != null
    gh run watch "$run_id" --exit-status
    ;;
  *) echo 'usage: release.sh trigger|watch vMAJOR.MINOR.PATCH' >&2; exit 2 ;;
esac
