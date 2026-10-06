import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const PACKING_RUNTIME_FILES = [
  'apps/daemon/dist/merkur-dataplane',
  'target/rust/release/merkur-edge',
  'target/rust/release/delay_proxy',
  'apps/web/src/term-wasm/pkg/term_wasm.js',
  'apps/web/src/term-wasm/pkg/term_wasm_bg.wasm',
  'packages/e2e-wasm/pkg/e2e_wasm.js',
  'packages/e2e-wasm/pkg/e2e_wasm_bg.wasm',
] as const;

const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

function treeHash(directory: string, excludeNestedDependencies = false): string {
  const entries: Array<{ path: string; kind: string; sha256: string }> = [];
  function visit(relative: string): void {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (excludeNestedDependencies && entry.name === 'node_modules') continue;
      const name = path.join(relative, entry.name);
      const target = path.join(directory, name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        entries.push({ path: name, kind: 'file', sha256: hash(readFileSync(target)) });
      else if (entry.isSymbolicLink())
        entries.push({ path: name, kind: 'symlink', sha256: hash(readlinkSync(target)) });
      else throw new Error(`unexpected packing artifact type: ${target}`);
    }
  }
  visit('');
  return hash(JSON.stringify(entries));
}

/** Expensive hashing is only before session startup/after final teardown, never per input. */
export function packingExecutionIdentity(directory: string, browserExecutable: string) {
  const cwd = realpathSync(directory);
  if (!path.isAbsolute(browserExecutable))
    throw new Error('packing browser executable must be absolute');
  const browserPath = realpathSync(browserExecutable);
  let bundlePath = path.dirname(browserPath);
  for (let parent = bundlePath; path.dirname(parent) !== parent; parent = path.dirname(parent)) {
    if (parent.endsWith('.app')) {
      bundlePath = parent;
      break;
    }
  }
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = git(['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .sort()
    .map((file) => ({ path: file, sha256: hash(readFileSync(path.join(cwd, file))) }));
  const requireRoot = createRequire(path.join(cwd, 'package.json'));
  const testPackage = path.dirname(requireRoot.resolve('@playwright/test/package.json'));
  const playwright = path.dirname(
    createRequire(path.join(testPackage, 'package.json')).resolve('playwright/package.json'),
  );
  const core = path.dirname(
    createRequire(path.join(playwright, 'package.json')).resolve('playwright-core/package.json'),
  );
  const executable = (name: 'PACKING_NODE_BINARY' | 'PACKING_BUN_BINARY') => {
    const requested = process.env[name];
    if (requested === undefined || !path.isAbsolute(requested))
      throw new Error(`exact ${name} required`);
    const binary = realpathSync(requested);
    return {
      path: binary,
      sha256: hash(readFileSync(binary)),
      version: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
    };
  };
  return {
    directory: cwd,
    checkpoint: git(['rev-parse', 'HEAD']).trim(),
    sourceSha256: hash(JSON.stringify(files)),
    overlaySha256: hash(git(['diff', '--binary', 'HEAD', '--'])),
    nativeAndWasm: PACKING_RUNTIME_FILES.map((file) => ({
      path: file,
      sha256: hash(readFileSync(path.join(cwd, file))),
    })),
    webBundleSha256: treeHash(path.join(cwd, 'apps/web/dist')),
    browser: {
      path: browserPath,
      executableSha256: hash(readFileSync(browserPath)),
      bundlePath,
      bundleSha256: treeHash(bundlePath),
    },
    testTools: [testPackage, playwright, core].map((directory) => ({
      path: realpathSync(directory),
      sha256: treeHash(directory, true),
    })),
    // Sealing runs under Bun; the actual Playwright driver runs under Node.
    // Hash both explicit executables instead of mislabeling the sealing realm.
    node: executable('PACKING_NODE_BINARY'),
    bun: executable('PACKING_BUN_BINARY'),
  };
}

export function requirePackingRunIdentity(
  directory: string,
  browserExecutable: string,
  manifestPath: string,
) {
  const expected: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    typeof expected !== 'object' ||
    expected === null ||
    !('identity' in expected) ||
    !('owner' in expected) ||
    expected.owner !== 'merkur-packing-delivery-sealed-run'
  )
    throw new Error('packing run manifest owner/schema is invalid');
  const identity = packingExecutionIdentity(directory, browserExecutable);
  if (JSON.stringify(identity) !== JSON.stringify(expected.identity))
    throw new Error('packing execution changed after manifest sealing');
  if (realpathSync(process.execPath) !== identity.node.path)
    throw new Error('packing test did not execute under the sealed Node driver');
  if (!statSync(manifestPath).isFile())
    throw new Error('packing run manifest is not a regular file');
  return identity;
}
