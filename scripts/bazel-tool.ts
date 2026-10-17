/**
 * A native helper a script runs: the one its Bazel test declares on PATH by name, or, run from
 * the checkout, the one Bazel builds there in the release profile.
 *
 * Node APIs only: benchmarks bundled for Node and Playwright's fixtures resolve their helpers
 * through this module too.
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

function bazel(root: string, args: readonly string[]): string {
  return execFileSync('bazel', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function onPath(name: string): string | undefined {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((directory) => path.join(directory, name))
    .find((candidate) => {
      const stats = statSync(candidate, { throwIfNoEntry: false });
      return stats !== undefined && !stats.isDirectory() && (stats.mode & 0o111) !== 0;
    });
}

/** `root` is the checkout: the caller names it, as bundled and CommonJS callers cannot ask. */
export function bazelTool(name: string, label: string, root: string): string {
  // Bazel sets TEST_SRCDIR in every test it runs; the test's PATH holds what it declared.
  if (process.env.TEST_SRCDIR !== undefined) {
    const declared = onPath(name);
    if (declared === undefined)
      throw new Error(`${name} is not on this test's PATH: declare ${label}`);
    return declared;
  }
  bazel(root, ['build', '--config=release', label]);
  const [file] = bazel(root, ['cquery', '--config=release', '--output=files', label]).split('\n');
  if (file === undefined || file === '') throw new Error(`${label} builds no file`);
  return path.join(bazel(root, ['info', '--config=release', 'execution_root']), file);
}
