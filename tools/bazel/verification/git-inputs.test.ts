import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishCapturedSourceInputs } from './captured-source';
import { captureGitContext } from './git-context';
import { acquireGitInputs, capturedSource } from './git-inputs';
import { withGitObjects } from './git-objects';
import { sourceLayout } from './source-tree';

test('acquired objects preserve merge ancestry and staged bytes without reading the original metadata', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'merkur-git-acquisition-control-'));
  const scratch = path.join(parent, 'source');
  mkdirSync(scratch);
  const git = process.env.MERKUR_VERIFICATION_GIT;
  if (git === undefined || !path.isAbsolute(git)) throw new Error('Declared Git required');
  const sdkEnvironment: Record<string, string> = {};
  for (const key of [
    'DYLD_LIBRARY_PATH',
    'DYLD_FALLBACK_LIBRARY_PATH',
    'GIT_EXEC_PATH',
    'GIT_TEMPLATE_DIR',
    'OPENSSL_CONF',
    'OPENSSL_MODULES',
    'MERKUR_BAZEL_NATIVE_SDK_PREFIX',
  ]) {
    const value = process.env[key];
    if (value !== undefined) sdkEnvironment[key] = value;
  }
  const environment = {
    ...sdkEnvironment,
    HOME: scratch,
    PATH: path.dirname(git),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Control',
    GIT_AUTHOR_EMAIL: 'control@example.invalid',
    GIT_COMMITTER_NAME: 'Control',
    GIT_COMMITTER_EMAIL: 'control@example.invalid',
  };
  const read = (args: readonly string[], input?: Uint8Array) => {
    const result = Bun.spawnSync([git, ...args], {
      cwd: scratch,
      env: environment,
      stdin: input === undefined ? 'ignore' : input,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout;
  };
  try {
    read(['init', '--template=', '--initial-branch=main']);
    writeFileSync(path.join(scratch, 'base.txt'), 'base\n');
    read(['add', 'base.txt']);
    read(['commit', '-m', 'base']);
    const base = read(['rev-parse', 'HEAD']).toString().trim();
    read(['checkout', '-b', 'side']);
    writeFileSync(path.join(scratch, 'side.txt'), 'side\n');
    read(['add', 'side.txt']);
    read(['commit', '-m', 'side']);
    const side = read(['rev-parse', 'HEAD']).toString().trim();
    read(['checkout', 'main']);
    writeFileSync(path.join(scratch, 'main.txt'), 'main\n');
    read(['add', 'main.txt']);
    read(['commit', '-m', 'main']);
    read(['merge', '--no-ff', '-m', 'merge', 'side']);
    writeFileSync(path.join(scratch, 'base.txt'), 'staged\n');
    read(['add', 'base.txt']);
    mkdirSync(path.join(scratch, 'pkg'));
    writeFileSync(path.join(scratch, 'pkg/raw.d.ts'), 'exact untracked raw declaration');
    mkdirSync(path.join(scratch, 'nested'));
    writeFileSync(path.join(scratch, 'nested/BUILD.bazel'), 'exact nested original build');
    symlinkSync('pkg', path.join(scratch, 'alias'));
    const head = read(['rev-parse', 'HEAD']).toString().trim();
    const capture = () => captureGitContext((args) => read(args).toString(), base, head);
    const context = capture();
    const destination = path.join(parent, 'acquired');
    const source = capturedSource({
      root: scratch,
      context,
      admittedUntracked: context.untracked,
      read,
    });

    acquireGitInputs({ root: scratch, destination, context, source, read, recapture: capture });
    const tree = path.join(parent, 'captured-tree');
    mkdirSync(tree);
    const inputs = Object.fromEntries(
      [...sourceLayout(source).files.values()].map((input) => [
        input.path,
        path.join(destination, 'payload', createHash('sha256').update(input.path).digest('hex')),
      ]),
    );
    await publishCapturedSourceInputs(source, inputs, tree);
    expect(readFileSync(path.join(tree, 'pkg/raw.d.ts'), 'utf8')).toBe(
      'exact untracked raw declaration',
    );
    expect(readFileSync(path.join(tree, 'nested/BUILD.bazel'), 'utf8')).toBe(
      'exact nested original build',
    );
    expect(readlinkSync(path.join(tree, 'alias'))).toBe('pkg');
    expect(readFileSync(path.join(destination, 'BUILD.bazel'), 'utf8')).toContain(
      'captured_source_tree(name="source_tree"',
    );
    const root = path.join(scratch, 'private-source');
    // The private source's metadata is reconstructed solely from the acquired declared Files.
    mkdirSync(root);
    withGitObjects(
      {
        executable: git,
        root,
        scratch,
        pack: path.join(destination, 'objects.pack'),
        evidence: JSON.parse(readFileSync(path.join(destination, 'git-objects.json'), 'utf8')),
        context,
        sdkEnvironment,
      },
      (env) => {
        const result = Bun.spawnSync([git, 'merge-base', side, head], {
          cwd: root,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString().trim()).toBe(side);
        const staged = Bun.spawnSync([git, 'show', ':base.txt'], {
          cwd: root,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(staged.exitCode).toBe(0);
        expect(staged.stdout.toString()).toBe('staged\n');
      },
    );
    const changed = { ...context, digest: 'f'.repeat(64) };
    expect(() =>
      acquireGitInputs({
        root: scratch,
        destination: path.join(parent, 'rejected'),
        context,
        source,
        read,
        recapture: () => changed,
      }),
    ).toThrow('changed');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
