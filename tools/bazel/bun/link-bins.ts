/**
 * The `node_modules/.bin` commands pnpm writes, for a test's checkout: rules_js links packages
 * but writes no `.bin`, and `bun run` finds a script's commands there.
 *
 *   bun link-bins.ts <node_modules directory>...
 *
 * It imports nothing but Node's own modules: Bazel runs it through a runfiles symlink, Bun
 * resolves its imports from the source checkout it points into, and that checkout has no
 * `node_modules` in a build that never ran pnpm.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function packages(modules: string): string[] {
  return readdirSync(modules)
    .filter((entry) => !entry.startsWith('.'))
    .flatMap((entry) =>
      entry.startsWith('@')
        ? readdirSync(path.join(modules, entry)).map((scoped) => `${entry}/${scoped}`)
        : [entry],
    );
}

/** A JSON string: `String` returns a string unchanged, and nothing else equal to its result. */
function isPath(value: unknown): value is string {
  return value === String(value);
}

/** A `bin` table: a JSON object whose every value is a path. */
function isPathTable(value: unknown): value is Record<string, string> {
  return value instanceof Object && !Array.isArray(value) && Object.values(value).every(isPath);
}

/** A package's commands, by name, with the file each runs: its manifest's `bin`. */
function bins(directory: string, name: string): [string, string][] {
  const manifest = path.join(directory, 'package.json');
  let text: string;
  try {
    text = readFileSync(manifest, 'utf8');
  } catch (error) {
    // A scope's directory, or a package pnpm linked without a manifest.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const { bin }: { bin?: unknown } = JSON.parse(text);
  if (bin === undefined) return [];
  if (isPath(bin)) return [[name.replace(/^@[^/]+\//, ''), bin]];
  if (isPathTable(bin)) return Object.entries(bin);
  throw new Error(`${manifest}: bin is neither a path nor a table of paths`);
}

for (const modules of process.argv.slice(2)) {
  const commands = path.join(modules, '.bin');
  mkdirSync(commands, { recursive: true });
  for (const name of packages(modules)) {
    const directory = path.join(modules, name);
    for (const [command, file] of bins(directory, name)) {
      const launcher = path.join(commands, command);
      writeFileSync(launcher, `#!/bin/sh\nexec node "${path.resolve(directory, file)}" "$@"\n`);
      chmodSync(launcher, 0o755);
    }
  }
}
