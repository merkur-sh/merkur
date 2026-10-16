import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

/** Every capture of `pattern` in `file`, which must hold at least one. */
function captures(file: string, pattern: RegExp): string[] {
  const found = [...read(file).matchAll(pattern)].map((match) => match[1] ?? '');
  expect(found.length, `${file} names no version for ${pattern}`).toBeGreaterThan(0);
  return found;
}

const DOCKERFILES = ['Dockerfile', 'Dockerfile.daemon-release', 'apps/site/Dockerfile'];

test('Bazel builds with the Rust release rust-toolchain.toml names', () => {
  const [channel] = captures('rust-toolchain.toml', /^channel = "([^"]+)"$/gm);
  expect(captures('MODULE.bazel', /versions = \["([^"]+)"\]/g)).toEqual([channel ?? '']);
  for (const archive of captures('MODULE.bazel', /"[a-z-]+-(\d+\.\d+\.\d+)-[a-z0-9_-]+\.tar\.xz"/g))
    expect(archive).toBe(channel ?? '');
});

test('Bazel, CI and the images run the Bun release .bun-version names', () => {
  const pinned = read('.bun-version').trim();
  expect(captures('tools/bazel/bun/extensions.bzl', /^BUN_VERSION = "([^"]+)"$/gm)).toEqual([
    pinned,
  ]);
  expect(captures('package.json', /"bun-types": "([^"]+)"/g)).toEqual([pinned]);
  for (const file of DOCKERFILES) {
    for (const version of captures(file, /bun-v(\d+\.\d+\.\d+)\//g)) expect(version).toBe(pinned);
  }
});

test('the images install the pnpm release packageManager names', () => {
  const [pinned] = captures('package.json', /"packageManager": "pnpm@([^"]+)"/g);
  for (const file of DOCKERFILES) {
    for (const version of captures(file, /pnpm\/releases\/download\/v(\d+\.\d+\.\d+)\//g))
      expect(version).toBe(pinned ?? '');
  }
});
