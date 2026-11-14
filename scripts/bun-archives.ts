/**
 * Pins the Bun release `.bun-version` names in `tools/bazel/bun/extensions.bzl`: its version and
 * each platform archive's SHA-256 from that release's `SHASUMS256.txt`. Bazel fetches every
 * archive against the digest written here, so a digest that does not match the archive fails the
 * fetch. Renovate runs this after it moves `.bun-version`.
 *
 *   bun run build:bun-archives
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const extensions = path.join(root, 'tools/bazel/bun/extensions.bzl');
const version = readFileSync(path.join(root, '.bun-version'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`.bun-version is not a release: ${version}`);

const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt`;
const response = await fetch(url);
if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
const digests = new Map<string, string>();
for (const line of (await response.text()).split('\n')) {
  const match = line.match(/^([0-9a-f]{64}) {2}(\S+)$/);
  if (match?.[1] !== undefined && match[2] !== undefined) digests.set(match[2], match[1]);
}

const pinned = readFileSync(extensions, 'utf8')
  .replace(/^BUN_VERSION = "[^"]*"$/m, `BUN_VERSION = "${version}"`)
  .replace(/\("([a-z0-9-]+)", "[0-9a-f]{64}"\)/g, (_, platform: string) => {
    const digest = digests.get(`bun-${platform}.zip`);
    if (digest === undefined) throw new Error(`${url} lists no bun-${platform}.zip`);
    return `("${platform}", "${digest}")`;
  });
writeFileSync(extensions, pinned);
process.stdout.write(`pinned Bun ${version} in ${path.relative(root, extensions)}\n`);
