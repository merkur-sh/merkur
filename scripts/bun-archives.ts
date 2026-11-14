/**
 * Pins the Bun release `.bun-version` names in `tools/bazel/bun/extensions.bzl`: its version and
 * the SHA-256 of each platform archive, hashed from the archive this downloads. Bazel fetches
 * every archive against the digest written here, so the pin is the digest of exactly the bytes
 * Bazel will accept. Renovate runs this after it moves `.bun-version`.
 *
 *   bun run build:bun-archives
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const extensions = path.join(root, 'tools/bazel/bun/extensions.bzl');
const version = readFileSync(path.join(root, '.bun-version'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`.bun-version is not a release: ${version}`);

const ARCHIVE = /\("([a-z0-9-]+)", "[0-9a-f]{64}"\)/g;
const source = readFileSync(extensions, 'utf8');
const digests = new Map<string, string>();
for (const [, platform] of source.matchAll(ARCHIVE)) {
  if (platform === undefined || digests.has(platform)) continue;
  if (!/^[a-z0-9]+-[a-z0-9-]+$/.test(platform)) throw new Error(`not a Bun platform: ${platform}`);
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-${platform}.zip`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await response.arrayBuffer());
  digests.set(platform, hasher.digest('hex'));
}

const pinned = source
  .replace(/^BUN_VERSION = "[^"]*"$/m, `BUN_VERSION = "${version}"`)
  .replace(ARCHIVE, (_, platform: string) => `("${platform}", "${digests.get(platform)}")`);
writeFileSync(extensions, pinned);
process.stdout.write(`pinned Bun ${version} in ${path.relative(root, extensions)}\n`);
