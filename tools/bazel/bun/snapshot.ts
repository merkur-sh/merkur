/**
 * A checkout of the whole repository, built once for every test that reads it as a whole
 * (`repo_snapshot` in `tools/bazel/bun/bun.bzl`): each declared file at its path, made a Git
 * repository whose one commit holds every file and every tracked symlink, so the gates see what
 * Git ignores as a working tree does. Its commit has fixed dates, so the same files make the same
 * repository. The symlinks leave the checkout once committed: a test clones the checkout following
 * links, and recreates them itself.
 *
 *   bun snapshot.ts <output directory> <manifest>
 *
 * The manifest holds one `file\t<source>\t<path>` or `link\t<path>\t<target>` line per entry.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

const [output, manifest] = process.argv.slice(2);
if (output === undefined || manifest === undefined)
  throw new Error('usage: snapshot.ts <output directory> <manifest>');

const links: string[] = [];
for (const line of readFileSync(manifest, 'utf8').split('\n')) {
  if (line === '') continue;
  const [kind, first, second] = line.split('\t');
  if (first === undefined || second === undefined) throw new Error(`bad entry: ${line}`);
  const at = path.join(output, kind === 'file' ? second : first);
  mkdirSync(path.dirname(at), { recursive: true });
  if (kind === 'file') copyFileSync(first, at);
  else if (kind === 'link') {
    symlinkSync(second, at);
    links.push(at);
  } else throw new Error(`bad entry: ${line}`);
}

const environment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'bazel',
  GIT_AUTHOR_EMAIL: 'bazel@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'bazel',
  GIT_COMMITTER_EMAIL: 'bazel@localhost',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};
// One pack, not a loose object per file: a test clones the checkout, and a clone costs per file.
for (const args of [
  ['init', '-q'],
  ['add', '-A'],
  ['commit', '-qm', 'checkout'],
  ['-c', 'pack.threads=1', 'repack', '-a', '-d', '-q'],
  ['prune'],
]) {
  const git = Bun.spawnSync(['git', ...args], {
    cwd: output,
    env: environment,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (git.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${git.exitCode}`);
}
for (const link of links) rmSync(link);
