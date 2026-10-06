import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexEntry } from './git-context';
import { validSourceManifest } from './snapshot';
import { materializeHeadSnapshot, materializeStagedSnapshot } from './staged-snapshot';

function fixture(format = 'sha1') {
  const executable = process.env.MERKUR_STAGED_SNAPSHOT_GIT;
  if (executable === undefined || !path.isAbsolute(executable))
    throw new Error('Staged snapshot controls require their declared Git executable');
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'merkur-staged-snapshot-')));
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
  const runGit = (args: readonly string[]) => {
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
        GIT_AUTHOR_NAME: 'Staged control',
        GIT_AUTHOR_EMAIL: 'staged@example.invalid',
        GIT_COMMITTER_NAME: 'Staged control',
        GIT_COMMITTER_EMAIL: 'staged@example.invalid',
      },
    });
    if (child.exitCode !== 0 || child.signalCode)
      throw new Error(`Declared Git control failed: ${child.stderr.toString()}`);
    return child.stdout;
  };
  runGit(['init', '--initial-branch=main', `--object-format=${format}`]);
  writeFileSync(path.join(sourceRoot, 'content.txt'), 'committed\n');
  runGit(['add', '--', 'content.txt']);
  runGit(['commit', '-m', 'base']);
  function captured() {
    const rows = runGit(['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean);
    const index: IndexEntry[] = rows.map((row) => {
      const split = row.indexOf('\t');
      const [mode, object, stage] = row.slice(0, split).split(' ');
      if (mode === undefined || object === undefined || stage !== '0')
        throw new Error('Control fixture has an invalid staged entry');
      return { path: row.slice(split + 1), mode, object };
    });
    return {
      sourceRoot,
      destination: path.join(temporary, 'index-source'),
      head: runGit(['rev-parse', 'HEAD^{commit}']).toString().trim(),
      indexTree: runGit(['write-tree']).toString().trim(),
      index,
      runGit,
    };
  }
  return {
    temporary,
    sourceRoot,
    runGit,
    captured,
    close: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

for (const format of ['sha1', 'sha256']) {
  test(`materializes ${format} index blobs, modes and links while live staged files differ`, () => {
    const f = fixture(format);
    try {
      writeFileSync(path.join(f.sourceRoot, 'content.txt'), 'staged\n');
      writeFileSync(path.join(f.sourceRoot, 'binary.bin'), Buffer.from([0, 255, 1, 128]));
      writeFileSync(path.join(f.sourceRoot, 'executable.sh'), '#!/declared/sh\n');
      chmodSync(path.join(f.sourceRoot, 'executable.sh'), 0o755);
      symlinkSync('content.txt', path.join(f.sourceRoot, 'alias'));
      f.runGit(['add', '--', 'content.txt', 'binary.bin', 'executable.sh', 'alias']);
      const captured = f.captured();
      writeFileSync(path.join(f.sourceRoot, 'content.txt'), 'unstaged-private\n');
      writeFileSync(path.join(f.sourceRoot, 'untracked.txt'), 'untracked-private\n');
      const result = materializeStagedSnapshot(captured);
      expect(validSourceManifest(result.manifest)).toBe(true);
      expect(result.head).toBe(captured.head);
      expect(result.indexTree).toBe(captured.indexTree);
      expect(readFileSync(path.join(result.manifest.root, 'content.txt'), 'utf8')).toBe('staged\n');
      expect(readFileSync(path.join(result.manifest.root, 'binary.bin'))).toEqual(
        Buffer.from([0, 255, 1, 128]),
      );
      expect(lstatSync(path.join(result.manifest.root, 'executable.sh')).mode & 0o777).toBe(0o755);
      expect(lstatSync(path.join(result.manifest.root, 'alias')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(result.manifest.root, 'alias'))).toBe('content.txt');
      expect(existsSync(path.join(result.manifest.root, 'untracked.txt'))).toBe(false);
      writeFileSync(path.join(f.sourceRoot, 'content.txt'), 'later-unstaged\n');
      result.assertCurrent();
      f.runGit(['add', '--', 'content.txt']);
      expect(result.assertCurrent).toThrow('HEAD or index changed');
    } finally {
      f.close();
    }
  });
}

test('index drift during blob reads refuses publication and removes only its own output', () => {
  const f = fixture();
  try {
    const captured = f.captured();
    let changed = false;
    expect(() =>
      materializeStagedSnapshot({
        ...captured,
        runGit(args) {
          const bytes = f.runGit(args);
          if (!changed && args[0] === 'cat-file') {
            changed = true;
            writeFileSync(path.join(f.sourceRoot, 'content.txt'), 'replacement\n');
            f.runGit(['add', '--', 'content.txt']);
          }
          return bytes;
        },
      }),
    ).toThrow('HEAD or index changed');
    expect(existsSync(captured.destination)).toBe(false);
    expect(readFileSync(path.join(f.sourceRoot, 'content.txt'), 'utf8')).toBe('replacement\n');
  } finally {
    f.close();
  }
});

test('rejects stale HEAD, unsupported entries, path escapes and caller-owned outputs', () => {
  const f = fixture();
  try {
    const captured = f.captured();
    for (const entry of [
      { ...captured.index[0], path: '../outside', mode: '100644', object: captured.head },
      { path: 'submodule', mode: '160000', object: captured.head },
    ])
      expect(() => materializeStagedSnapshot({ ...captured, index: [entry] })).toThrow();
    expect(() =>
      materializeStagedSnapshot({ ...captured, destination: path.join(f.sourceRoot, 'snapshot') }),
    ).toThrow('outside');
    mkdirSync(captured.destination);
    const caller = path.join(captured.destination, 'caller.txt');
    writeFileSync(caller, 'caller-bytes');
    expect(() => materializeStagedSnapshot(captured)).toThrow('caller-owned');
    expect(readFileSync(caller, 'utf8')).toBe('caller-bytes');
    f.runGit(['commit', '--allow-empty', '-m', 'new HEAD']);
    expect(() => materializeStagedSnapshot(captured)).toThrow('HEAD or index changed');
  } finally {
    f.close();
  }
});

test('rejects index symlinks which would read bytes outside the staged source tree', () => {
  const f = fixture();
  try {
    symlinkSync('../outside.txt', path.join(f.sourceRoot, 'escape'));
    f.runGit(['add', '--', 'escape']);
    const captured = f.captured();
    writeFileSync(path.join(f.temporary, 'outside.txt'), 'outside-private');
    expect(() => materializeStagedSnapshot(captured)).toThrow('symlink escapes');
    expect(existsSync(captured.destination)).toBe(false);
  } finally {
    f.close();
  }
});

test('assert-current rejects HEAD changing between its declared Git reads', () => {
  const f = fixture();
  try {
    const captured = f.captured();
    let inject = false;
    const result = materializeStagedSnapshot({
      ...captured,
      runGit(args) {
        const bytes = f.runGit(args);
        if (inject && args[0] === 'rev-parse') {
          inject = false;
          f.runGit(['commit', '--allow-empty', '-m', 'concurrent HEAD']);
        }
        return bytes;
      },
    });
    inject = true;
    expect(result.assertCurrent).toThrow('HEAD or index changed');
  } finally {
    f.close();
  }
});

test('a real conflicted Git index is refused before output creation', () => {
  const f = fixture();
  try {
    const base = f.captured().head;
    writeFileSync(path.join(f.sourceRoot, 'content.txt'), 'left\n');
    f.runGit(['add', '--', 'content.txt']);
    f.runGit(['commit', '-m', 'left']);
    const left = f.captured().head;
    f.runGit(['checkout', '--detach', base]);
    writeFileSync(path.join(f.sourceRoot, 'content.txt'), 'right\n');
    f.runGit(['add', '--', 'content.txt']);
    f.runGit(['commit', '-m', 'right']);
    const captured = f.captured();
    f.runGit(['read-tree', '--reset', '-u', left]);
    f.runGit(['read-tree', '-m', base, left, captured.head]);
    expect(() => materializeStagedSnapshot(captured)).toThrow('unresolved merge entries');
    expect(existsSync(captured.destination)).toBe(false);
  } finally {
    f.close();
  }
});

test('declared cat-file output must preserve the original binary blob identity', () => {
  const f = fixture();
  try {
    const captured = f.captured();
    expect(() =>
      materializeStagedSnapshot({
        ...captured,
        runGit(args) {
          return args[0] === 'cat-file' ? Buffer.from('not-the-index-object') : f.runGit(args);
        },
      }),
    ).toThrow('blob bytes differ');
    expect(existsSync(captured.destination)).toBe(false);
  } finally {
    f.close();
  }
});

for (const format of ['sha1', 'sha256']) {
  test(`materializes the ${format} HEAD baseline independently of staged and live bytes`, () => {
    const f = fixture(format);
    try {
      mkdirSync(path.join(f.sourceRoot, 'nested'));
      const binary = 'nested/with\ttab\nand-newline.bin';
      writeFileSync(path.join(f.sourceRoot, binary), Buffer.from([0, 255, 128, 1]));
      writeFileSync(path.join(f.sourceRoot, 'nested', 'execute'), 'committed executable\n');
      chmodSync(path.join(f.sourceRoot, 'nested', 'execute'), 0o755);
      symlinkSync('../content.txt', path.join(f.sourceRoot, 'nested', 'alias'));
      f.runGit(['add', '--', 'nested']);
      f.runGit(['commit', '-m', 'head inputs']);
      const captured = f.captured();
      writeFileSync(path.join(f.sourceRoot, 'content.txt'), 'staged content\n');
      writeFileSync(path.join(f.sourceRoot, 'added.txt'), 'staged addition\n');
      f.runGit(['add', '--', 'content.txt', 'added.txt']);
      writeFileSync(path.join(f.sourceRoot, 'content.txt'), 'unstaged content\n');
      writeFileSync(path.join(f.sourceRoot, 'untracked.txt'), 'untracked content\n');
      const destination = path.join(f.temporary, 'head-source');
      const snapshot = materializeHeadSnapshot({ ...captured, destination });
      expect(snapshot.manifest.commit).toBe(captured.head);
      expect(validSourceManifest(snapshot.manifest)).toBe(true);
      expect(snapshot.manifest.inputs.map((input) => input.path)).toEqual([
        'content.txt',
        'nested/alias',
        'nested/execute',
        binary,
      ]);
      expect(readFileSync(path.join(destination, 'content.txt'), 'utf8')).toBe('committed\n');
      expect(readFileSync(path.join(destination, binary))).toEqual(Buffer.from([0, 255, 128, 1]));
      expect(lstatSync(path.join(destination, 'nested', 'execute')).mode & 0o777).toBe(0o755);
      expect(readlinkSync(path.join(destination, 'nested', 'alias'))).toBe('../content.txt');
      expect(existsSync(path.join(destination, 'added.txt'))).toBe(false);
      expect(existsSync(path.join(destination, 'untracked.txt'))).toBe(false);
      writeFileSync(path.join(f.sourceRoot, 'content.txt'), 'later staged content\n');
      f.runGit(['add', '--', 'content.txt']);
      expect(() => snapshot.assertCurrent()).not.toThrow();
      f.runGit(['commit', '-m', 'new head']);
      expect(() => snapshot.assertCurrent()).toThrow('head changed');
    } finally {
      f.close();
    }
  });
}

test('HEAD drift during ls-tree acquisition refuses output before creating it', () => {
  const f = fixture();
  try {
    const captured = f.captured();
    const destination = path.join(f.temporary, 'head-source');
    let changed = false;
    expect(() =>
      materializeHeadSnapshot({
        ...captured,
        destination,
        runGit(args) {
          const bytes = f.runGit(args);
          if (args[0] === 'ls-tree') {
            expect(args).toEqual(['ls-tree', '-rz', '--full-tree', captured.head]);
            changed = true;
            f.runGit(['commit', '--allow-empty', '-m', 'head race']);
          }
          return bytes;
        },
      }),
    ).toThrow('head changed');
    expect(changed).toBe(true);
    expect(existsSync(destination)).toBe(false);
  } finally {
    f.close();
  }
});

test('HEAD drift during blob acquisition removes only the new materialization', () => {
  const f = fixture();
  try {
    const captured = f.captured();
    const destination = path.join(f.temporary, 'head-source');
    let changed = false;
    expect(() =>
      materializeHeadSnapshot({
        ...captured,
        destination,
        runGit(args) {
          const bytes = f.runGit(args);
          if (!changed && args[0] === 'cat-file') {
            changed = true;
            f.runGit(['commit', '--allow-empty', '-m', 'head race']);
          }
          return bytes;
        },
      }),
    ).toThrow('head changed');
    expect(changed).toBe(true);
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(path.join(f.sourceRoot, 'content.txt'), 'utf8')).toBe('committed\n');
  } finally {
    f.close();
  }
});

test('HEAD snapshots refuse actual committed Git links', () => {
  const f = fixture();
  try {
    const original = f.captured();
    f.runGit(['update-index', '--add', '--cacheinfo', `160000,${original.head},foreign`]);
    f.runGit(['commit', '-m', 'git link']);
    const captured = f.captured();
    const destination = path.join(f.temporary, 'head-source');
    expect(() => materializeHeadSnapshot({ ...captured, destination })).toThrow(
      'unsupported tree entry',
    );
    expect(existsSync(destination)).toBe(false);
  } finally {
    f.close();
  }
});

test('HEAD snapshots share blob integrity and exclusive output ownership controls', () => {
  const f = fixture();
  try {
    const captured = f.captured();
    const destination = path.join(f.temporary, 'head-source');
    expect(() =>
      materializeHeadSnapshot({
        ...captured,
        destination,
        runGit(args) {
          return args[0] === 'cat-file' ? Buffer.from('corrupt head blob') : f.runGit(args);
        },
      }),
    ).toThrow('blob bytes differ');
    expect(existsSync(destination)).toBe(false);
    mkdirSync(destination);
    writeFileSync(path.join(destination, 'caller-owned.txt'), 'caller-owned\n');
    expect(() => materializeHeadSnapshot({ ...captured, destination })).toThrow();
    expect(readFileSync(path.join(destination, 'caller-owned.txt'), 'utf8')).toBe('caller-owned\n');
  } finally {
    f.close();
  }
});

test('HEAD snapshot tree records cannot truncate, duplicate, escape or mislabel entries', () => {
  const f = fixture();
  try {
    const captured = f.captured();
    const original = f.runGit(['ls-tree', '-rz', '--full-tree', captured.head]);
    const blob = captured.index.find((entry) => entry.path === 'content.txt')?.object;
    if (blob === undefined) throw new Error('Control fixture lost its committed blob');
    const records = [
      original.subarray(0, original.length - 1),
      Buffer.concat([original, original]),
      Buffer.from(`100644 blob ${blob}\t../outside\0`),
      Buffer.from(`100644 tree ${blob}\tcontent.txt\0`),
    ];
    for (const bytes of records) {
      const destination = path.join(f.temporary, 'head-source');
      expect(() =>
        materializeHeadSnapshot({
          ...captured,
          destination,
          runGit(args) {
            return args[0] === 'ls-tree' ? bytes : f.runGit(args);
          },
        }),
      ).toThrow();
      expect(existsSync(destination)).toBe(false);
    }
  } finally {
    f.close();
  }
});
