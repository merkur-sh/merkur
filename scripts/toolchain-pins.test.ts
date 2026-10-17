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

const DOCKERFILES = ['Dockerfile'];

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

test('the wasm-bindgen CLI is the release of the crate Cargo.lock pins', () => {
  const locked = captures('Cargo.lock', /^name = "wasm-bindgen"\nversion = "([^"]+)"$/gm);
  expect(
    captures('tools/bazel/wasm/extensions.bzl', /^WASM_BINDGEN_VERSION = "([^"]+)"$/gm),
  ).toEqual(locked);
});

test('Bazel installs the Chromium revision playwright-core launches', () => {
  // `@playwright/test` → `playwright` → `playwright-core`, each resolved from the last.
  const from = (specifier: string, directory: string) =>
    path.dirname(Bun.resolveSync(`${specifier}/package.json`, directory));
  const core = from('playwright-core', from('playwright', from('@playwright/test', ROOT)));
  const manifest: { browsers: { name: string; revision: string; browserVersion: string }[] } =
    JSON.parse(readFileSync(path.join(core, 'browsers.json'), 'utf8'));
  const [revision] = captures(
    'tools/bazel/playwright/extensions.bzl',
    /^CHROMIUM_REVISION = "([^"]+)"$/gm,
  );
  const [version] = captures(
    'tools/bazel/playwright/extensions.bzl',
    /^CHROMIUM_VERSION = "([^"]+)"$/gm,
  );
  for (const name of ['chromium', 'chromium-headless-shell']) {
    const browser = manifest.browsers.find((entry) => entry.name === name);
    expect(browser?.revision, name).toBe(revision);
    expect(browser?.browserVersion, name).toBe(version);
  }
});

test('Bazel runs the Node release .node-version names', () => {
  const pinned = read('.node-version').trim();
  const archives = captures('MODULE.bazel', /^ {8}"(\d+\.\d+\.\d+)-[a-z0-9_]+": \["node-v/gm);
  expect(archives.length).toBe(4);
  for (const version of archives) expect(version).toBe(pinned);
});
