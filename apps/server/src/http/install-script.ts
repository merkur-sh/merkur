import { RELEASE_DOWNLOAD_BASE_URL } from '@merkur/shared';

export const INSTALL_SCRIPT_CONTENT_TYPE = 'text/x-shellscript; charset=utf-8';

/**
 * `curl -fsSL <origin>/install | sh`: the daemon installer.
 *
 * The script is deliberately thin. It picks the platform, downloads the newest
 * release's archive, manifest, and signature from GitHub, and hands all three to
 * the `merkur` binary inside the archive. `merkur setup` then verifies the
 * ML-DSA-87 manifest signature and the archive against it with the updater's own
 * code, installs into `~/.merkur`, and puts `merkur` on `PATH`.
 *
 * This first step is trust on first use: a script, binary, and key that all
 * arrive over HTTPS can be replaced together by whoever controls that channel,
 * so the binary vouching for its own release proves consistency, not origin.
 * Setup prints the release key's fingerprint so it can be compared against a
 * channel this download did not use; every update after it is verified against
 * that key. `docs/releases.md` states the boundary.
 *
 * With `MERKUR_LINK_TOKEN` in its environment — the browser's link command
 * puts it there — setup goes on to link this machine to the origin that served
 * the script and installs the service once the link is approved.
 *
 * `MERKUR_RELEASE_BASE` points the downloads at another directory of release
 * assets; the installer test serves test-signed artifacts through it.
 */
export function renderInstallScript(publicOrigin: string): string {
  return `#!/bin/sh
# Merkur installer for ${publicOrigin}
#
#   curl -fsSL ${publicOrigin}/install | sh
#
# Downloads the newest signed Merkur release for this machine and installs it
# into ~/.merkur. The first install trusts HTTPS: compare the release-key
# fingerprint it prints with the one in Merkur's README. Every later update is
# verified against that key.
set -eu

release_base="\${MERKUR_RELEASE_BASE:-${RELEASE_DOWNLOAD_BASE_URL}/latest/download}"

fail() {
  printf 'merkur install: %s\\n' "$1" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported operating system $(uname -s); Merkur runs on macOS and Linux" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported processor $(uname -m); Merkur runs on arm64 and x86_64" ;;
esac
# A shell running under Rosetta reports x86_64 on an Apple Silicon Mac.
if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi
artifact="merkur-daemon-$os-$arch.tar.gz"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto-redir '=https' -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail 'curl or wget is required'
fi
command -v tar >/dev/null 2>&1 || fail 'tar is required'

# Unpacked under ~/.merkur rather than /tmp, which is mounted noexec on
# hardened hosts.
mkdir -p "$HOME/.merkur"
work=$(mktemp -d "$HOME/.merkur/install.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 1' INT TERM HUP

printf 'Downloading Merkur for %s-%s\\n' "$os" "$arch"
for file in "$artifact" merkur-release.json merkur-release.sig; do
  fetch "$release_base/$file" "$work/$file" || fail "could not download $release_base/$file"
done
mkdir "$work/unpacked"
tar -xzf "$work/$artifact" -C "$work/unpacked" merkur ||
  fail "$artifact is not a Merkur release archive"

# The link command from the browser sets MERKUR_LINK_TOKEN; arguments after
# \`sh -s --\` (such as \`--identity-backend none\`) go to \`merkur link\`.
if [ -n "\${MERKUR_LINK_TOKEN:-}" ]; then
  set -- --link ${quotePosix(publicOrigin)} "$@"
elif [ "$#" -gt 0 ]; then
  fail 'link options need the link command from Merkur in your browser'
fi

"$work/unpacked/merkur" setup \\
  "$work/$artifact" "$work/merkur-release.json" "$work/merkur-release.sig" "$@" </dev/null
`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
