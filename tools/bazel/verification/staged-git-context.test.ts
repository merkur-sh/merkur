import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureGitContext, validGitContext } from './git-context';
import { materializeStagedSnapshot } from './staged-snapshot';

function fixture(format = 'sha1') {
  const executable = process.env.MERKUR_STAGED_SNAPSHOT_GIT;
  if (executable === undefined || !path.isAbsolute(executable))
    throw new Error('Staged Git context controls require their declared Git executable');
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'merkur-staged-context-')));
  const sourceRoot = path.join(temporary, 'source');
  const home = path.join(temporary, 'home');
  mkdirSync(sourceRoot);
  mkdirSync(home);
  const sdk = Object.fromEntries(
    [
      'DYLD_LIBRARY_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'LD_LIBRARY_PATH',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      'OPENSSL_CONF',
      'OPENSSL_MODULES',
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]] as const])),
  );
  const bytes = (args: readonly string[]) => {
    const child = Bun.spawnSync([executable, ...args], {
      cwd: sourceRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...sdk,
        HOME: home,
        PATH: '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'Staged context control',
        GIT_AUTHOR_EMAIL: 'staged@example.invalid',
        GIT_COMMITTER_NAME: 'Staged context control',
        GIT_COMMITTER_EMAIL: 'staged@example.invalid',
      },
    });
    if (child.exitCode !== 0 || child.signalCode)
      throw new Error(`Declared Git context control failed: ${child.stderr.toString()}`);
    return child.stdout;
  };
  const read = (args: readonly string[]) => bytes(args).toString();
  const write = (name: string, content: string) =>
    writeFileSync(path.join(sourceRoot, name), content);
  read(['init', '--initial-branch=main', `--object-format=${format}`]);
  for (const name of ['partial.txt', 'live.txt', 'removed.txt']) write(name, `base ${name}\n`);
  read(['add', '--', 'partial.txt', 'live.txt', 'removed.txt']);
  read(['commit', '-m', 'base']);
  const head = read(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  return {
    temporary,
    sourceRoot,
    head,
    write,
    bytes,
    read,
    capture: () => captureGitContext(read, head, head, true),
    close: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

for (const format of ['sha1', 'sha256']) {
  describe(`${format} partially staged index`, () => {
    let active: ReturnType<typeof fixture> | undefined;
    let captured: ReturnType<typeof captureGitContext> | undefined;
    beforeEach(() => {
      const git = fixture(format);
      active = git;
      git.write('partial.txt', 'staged partial\n');
      git.write('added.txt', 'staged addition\n');
      git.read(['add', '--', 'partial.txt', 'added.txt']);
      git.read(['rm', '--', 'removed.txt']);
      git.write('partial.txt', 'unstaged partial\n');
      git.write('live.txt', 'unstaged only\n');
      git.write('untracked.txt', 'untracked bytes\n');
      captured = git.capture();
    });
    afterEach(() => {
      active?.close();
      active = undefined;
      captured = undefined;
    });
    test('captures only staged ownership changes and ignores later live-only edits', () => {
      const git = active;
      const context = captured;
      if (git === undefined || context === undefined) throw new Error('Staged fixture is absent');
      expect(validGitContext(context)).toBe(true);
      expect(context.base).toBe(git.head);
      expect(context.candidate).toBe(git.head);
      expect(context.head).toBe(git.head);
      expect(context.committed).toEqual([]);
      expect(context.untracked).toEqual([]);
      expect(context.unstaged).toEqual([]);
      expect(context.staged).toEqual(['added.txt', 'partial.txt', 'removed.txt']);
      expect(context.changed).toEqual(context.staged);
      expect(context.index.map((entry) => entry.path)).toEqual([
        'added.txt',
        'live.txt',
        'partial.txt',
      ]);
      git.write('partial.txt', 'later unstaged partial\n');
      git.write('live.txt', 'later unstaged only\n');
      git.write('untracked.txt', 'later untracked bytes\n');
      expect(git.capture().digest).toBe(context.digest);
      expect(() => captureGitContext(git.read, git.head, git.head)).toThrow('Partially staged');
    });
    test('materializes original index bytes while staged files have live-only edits', () => {
      const git = active;
      const context = captured;
      if (git === undefined || context === undefined) throw new Error('Staged fixture is absent');
      const snapshot = materializeStagedSnapshot({
        sourceRoot: git.sourceRoot,
        destination: path.join(git.temporary, 'index-source'),
        head: context.head,
        index: context.index,
        indexTree: git.read(['write-tree']).trim(),
        runGit: git.bytes,
      });
      expect(snapshot.manifest.inputs.map((input) => input.path)).toEqual([
        'added.txt',
        'live.txt',
        'partial.txt',
      ]);
      expect(readFileSync(path.join(snapshot.manifest.root, 'partial.txt'), 'utf8')).toBe(
        'staged partial\n',
      );
      expect(readFileSync(path.join(snapshot.manifest.root, 'live.txt'), 'utf8')).toBe(
        'base live.txt\n',
      );
    });
  });
}

test('unstaged modifications, deletions and untracked paths never select staged targets', () => {
  const git = fixture();
  try {
    const before = git.capture();
    git.write('partial.txt', 'unstaged only\n');
    rmSync(path.join(git.sourceRoot, 'removed.txt'));
    git.write('untracked.txt', 'untracked only\n');
    const after = git.capture();
    expect(after.digest).toBe(before.digest);
    expect(after.changed).toEqual([]);
    expect(after.staged).toEqual([]);
    expect(after.index).toEqual(before.index);
    const live = captureGitContext(git.read, git.head, git.head, false);
    expect(live.unstaged).toEqual(['partial.txt', 'removed.txt']);
    expect(live.untracked).toEqual(['untracked.txt']);
  } finally {
    git.close();
  }
});

test('staged capture requires both baseline identities to equal the current HEAD', () => {
  const git = fixture();
  try {
    git.read(['commit', '--allow-empty', '-m', 'next head']);
    const next = git.read(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    for (const [base, candidate] of [
      [git.head, next],
      [next, git.head],
      [git.head, git.head],
    ]) {
      if (base === undefined || candidate === undefined) throw new Error('Invalid control');
      expect(() => captureGitContext(git.read, base, candidate, true)).toThrow('exact HEAD');
    }
    expect(validGitContext(captureGitContext(git.read, next, next, true))).toBe(true);
  } finally {
    git.close();
  }
});

test('staged capture rejects index drift while reading independent Git facts', () => {
  const git = fixture();
  try {
    let changed = false;
    const read = (args: readonly string[]) => {
      const result = git.read(args);
      if (!changed && args[0] === 'ls-files' && args.includes('--stage')) {
        changed = true;
        git.write('partial.txt', 'concurrently staged\n');
        git.read(['add', '--', 'partial.txt']);
      }
      return result;
    };
    expect(() => captureGitContext(read, git.head, git.head, true)).toThrow(
      'Git context changed during capture',
    );
    expect(changed).toBe(true);
    expect(git.capture().staged).toEqual(['partial.txt']);
  } finally {
    git.close();
  }
});

test('staged capture rejects HEAD drift after its initial HEAD read', () => {
  const git = fixture();
  try {
    let changed = false;
    const read = (args: readonly string[]) => {
      const result = git.read(args);
      if (!changed && args.includes('HEAD^{commit}')) {
        changed = true;
        git.read(['commit', '--allow-empty', '-m', 'concurrent head']);
      }
      return result;
    };
    expect(() => captureGitContext(read, git.head, git.head, true)).toThrow(
      'Git context changed during capture',
    );
    expect(changed).toBe(true);
  } finally {
    git.close();
  }
});
