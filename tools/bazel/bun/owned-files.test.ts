import { dlopen, ptr } from 'bun:ffi';
import { expect, spyOn, test } from 'bun:test';
import * as filesystem from 'node:fs';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOwnedDirectory, openReadOnlyDirectory } from './owned-files';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'owned-files-'));
  const directory = openOwnedDirectory(root);
  return {
    root,
    directory,
    close: () => {
      directory.close();
      rmSync(root, { recursive: true });
    },
  };
}

test('sync flushes held file bytes and every containing directory without path reopening', () => {
  const item = fixture();
  const fsync = filesystem.fsyncSync;
  const flushed: number[] = [];
  const spy = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    flushed.push(filesystem.fstatSync(fd).ino);
    fsync(fd);
  });
  try {
    mkdirSync(path.join(item.root, 'caller'));
    item.directory.write('caller/nested/output', 'durable bytes');
    item.directory.sync('caller/nested/output');
    expect(flushed).toEqual(
      ['caller/nested/output', 'caller/nested', 'caller', ''].map(
        (member) => statSync(path.join(item.root, member)).ino,
      ),
    );
    expect(readFileSync(path.join(item.root, 'caller/nested/output'), 'utf8')).toBe(
      'durable bytes',
    );
  } finally {
    spy.mockRestore();
    item.close();
  }
});

for (const failedCall of [1, 2]) {
  test(`sync refuses actual fsync EBADF at ${failedCall === 1 ? 'file' : 'parent'} submission`, () => {
    const item = fixture();
    const fsync = filesystem.fsyncSync;
    let calls = 0;
    const spy = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
      calls += 1;
      // A nonnegative descriptor outside this process' table reaches the native syscall.
      fsync(calls === failedCall ? 0x7fffffff : fd);
    });
    try {
      item.directory.write('nested/output', 'retained');
      expect(() => item.directory.sync('nested/output')).toThrow('EBADF');
      expect(calls).toBe(failedCall);
      item.directory.verify('nested/output');
    } finally {
      spy.mockRestore();
      item.close();
    }
  });
}

test('sync refuses files outside its creation journal, aliases and closed capabilities', () => {
  const item = fixture();
  try {
    writeFileSync(path.join(item.root, 'caller'), 'caller bytes');
    item.directory.readExisting('caller');
    item.directory.symlink('alias', 'caller');
    for (const member of ['caller', 'alias', '../caller', '/caller'])
      expect(() => item.directory.sync(member)).toThrow('owned regular file');
    item.directory.write('output', 'owned');
    item.directory.close();
    expect(() => item.directory.sync('output')).toThrow('closed');
    expect(readFileSync(path.join(item.root, 'caller'), 'utf8')).toBe('caller bytes');
  } finally {
    item.close();
  }
});

test('sync refuses a containing-directory replacement during native submission', () => {
  const item = fixture();
  const fsync = filesystem.fsyncSync;
  let replaced = false;
  const spy = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    fsync(fd);
    if (replaced) return;
    replaced = true;
    renameSync(path.join(item.root, 'nested'), path.join(item.root, 'retained'));
    symlinkSync(path.join(item.root, 'outside'), path.join(item.root, 'nested'));
  });
  try {
    mkdirSync(path.join(item.root, 'outside'));
    writeFileSync(path.join(item.root, 'outside/output'), 'foreign');
    item.directory.write('nested/output', 'owned');
    expect(() => item.directory.sync('nested/output')).toThrow('namespace changed');
    expect(readFileSync(path.join(item.root, 'outside/output'), 'utf8')).toBe('foreign');
    expect(readFileSync(path.join(item.root, 'retained/output'), 'utf8')).toBe('owned');
  } finally {
    spy.mockRestore();
    item.close();
  }
});

test('sync refuses byte mutation during native submission', () => {
  const item = fixture();
  const fsync = filesystem.fsyncSync;
  const spy = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    fsync(fd);
    writeFileSync(path.join(item.root, 'output'), 'other');
  });
  try {
    item.directory.write('output', 'owned');
    expect(() => item.directory.sync('output')).toThrow('bytes changed');
  } finally {
    spy.mockRestore();
    item.close();
  }
});

test('owned creation preserves exact modes, bytes, aliases and caller directories', () => {
  const item = fixture();
  try {
    mkdirSync(path.join(item.root, 'existing'));
    item.directory.write('existing/nested/executable', 'owned', 0o755);
    item.directory.symlink('existing/alias', 'nested/executable');
    item.directory.verify('existing/nested/executable');
    item.directory.verify('existing/alias');
    expect(statSync(path.join(item.root, 'existing/nested/executable')).mode & 0o777).toBe(0o755);
    item.directory.removeCreated();
    expect(statSync(path.join(item.root, 'existing')).isDirectory()).toBe(true);
  } finally {
    item.close();
  }
});

test('ancestor replacement cannot redirect writes or removal outside the held root', () => {
  const item = fixture();
  try {
    item.directory.write('nested/one', 'first');
    mkdirSync(path.join(item.root, 'outside'));
    writeFileSync(path.join(item.root, 'outside/one'), 'outside');
    renameSync(path.join(item.root, 'nested'), path.join(item.root, 'retained'));
    symlinkSync(path.join(item.root, 'outside'), path.join(item.root, 'nested'));
    expect(() => item.directory.write('nested/two', 'second')).toThrow('namespace changed');
    expect(() => item.directory.removeCreated()).toThrow('namespace changed');
    expect(readFileSync(path.join(item.root, 'outside/one'), 'utf8')).toBe('outside');
    expect(() => statSync(path.join(item.root, 'outside/two'))).toThrow();
  } finally {
    item.close();
  }
});

test('a journal sweep refuses what a member-by-member proof refuses', () => {
  const sweep = (change: (root: string) => void, files = ['nested/deep/one', 'alias']) => {
    const item = fixture();
    try {
      item.directory.write('nested/deep/one', 'first', 0o640);
      item.directory.symlink('alias', 'nested/deep/one');
      item.directory.directory('empty');
      item.directory.setDirectoryMode('empty', 0o700);
      item.directory.verifyJournal(['', 'nested', 'nested/deep', 'empty'], files);
      change(item.root);
      item.directory.verifyJournal(['', 'nested', 'nested/deep', 'empty'], files);
    } finally {
      item.close();
    }
  };
  sweep(() => {});
  // An ancestor that holds no listed member directly is still proved.
  expect(() =>
    sweep((root) => {
      renameSync(path.join(root, 'nested'), path.join(root, 'retained'));
      mkdirSync(path.join(root, 'nested/deep'), { recursive: true });
      writeFileSync(path.join(root, 'nested/deep/one'), 'first', { mode: 0o640 });
    }),
  ).toThrow('namespace changed');
  expect(() =>
    sweep((root) => {
      renameSync(path.join(root, 'nested/deep/one'), path.join(root, 'nested/deep/held'));
      writeFileSync(path.join(root, 'nested/deep/one'), 'first', { mode: 0o640 });
    }),
  ).toThrow('namespace changed');
  expect(() => sweep((root) => writeFileSync(path.join(root, 'nested/deep/one'), 'other'))).toThrow(
    'bytes changed',
  );
  expect(() =>
    sweep((root) => {
      rmSync(path.join(root, 'alias'));
      symlinkSync('nested', path.join(root, 'alias'));
    }),
  ).toThrow('namespace changed');
  expect(() => sweep((root) => filesystem.chmodSync(path.join(root, 'empty'), 0o755))).toThrow(
    'directory facts changed',
  );
  expect(() => sweep(() => {}, ['nested/deep/one', 'foreign'])).toThrow('outside the owned');
});

test('leaf replacement and mutation are refused while cleanup remains inode-owned', () => {
  const item = fixture();
  try {
    item.directory.write('mutable', 'owned');
    writeFileSync(path.join(item.root, 'mutable'), 'changed');
    expect(() => item.directory.verify('mutable')).toThrow('file facts changed');
    item.directory.removeCreated();
    item.directory.write('replaced', 'owned');
    renameSync(path.join(item.root, 'replaced'), path.join(item.root, 'retained'));
    writeFileSync(path.join(item.root, 'replaced'), 'foreign');
    expect(() => item.directory.removeCreated()).toThrow('namespace changed');
    expect(readFileSync(path.join(item.root, 'replaced'), 'utf8')).toBe('foreign');
  } finally {
    item.close();
  }
});

test('absolute paths, traversal and existing output aliases never overwrite referents', () => {
  const item = fixture();
  try {
    writeFileSync(path.join(item.root, 'foreign'), 'retained');
    symlinkSync('foreign', path.join(item.root, 'alias'));
    for (const output of ['/absolute', '../escape', 'nested/../escape', 'alias'])
      expect(() => item.directory.write(output, 'changed')).toThrow();
    expect(readFileSync(path.join(item.root, 'foreign'), 'utf8')).toBe('retained');
  } finally {
    item.close();
  }
});

test('special-file replacement cannot block namespace verification or cleanup', () => {
  const item = fixture();
  const library = dlopen(
    process.platform === 'darwin'
      ? '/usr/lib/libSystem.B.dylib'
      : process.arch === 'arm64'
        ? '/lib/aarch64-linux-gnu/libc.so.6'
        : '/lib/x86_64-linux-gnu/libc.so.6',
    { mkfifo: { args: ['ptr', 'u32'], returns: 'i32' } },
  );
  try {
    item.directory.write('output', 'owned');
    renameSync(path.join(item.root, 'output'), path.join(item.root, 'retained'));
    const fifo = Buffer.from(`${path.join(item.root, 'output')}\0`);
    expect(library.symbols.mkfifo(ptr(fifo), 0o600)).toBe(0);
    expect(() => item.directory.verify('output')).toThrow('namespace changed');
    expect(() => item.directory.removeCreated()).toThrow('namespace changed');
    expect(lstatSync(path.join(item.root, 'output')).isFIFO()).toBe(true);
  } finally {
    library.close();
    item.close();
  }
});

test('cleanup attempts every independently matching branch before reporting refusals', () => {
  const item = fixture();
  try {
    item.directory.write('good/a', 'owned');
    item.directory.write('bad/b', 'owned');
    mkdirSync(path.join(item.root, 'outside'));
    writeFileSync(path.join(item.root, 'outside/b'), 'foreign');
    renameSync(path.join(item.root, 'bad'), path.join(item.root, 'retained'));
    symlinkSync(path.join(item.root, 'outside'), path.join(item.root, 'bad'));
    expect(() => item.directory.removeCreated()).toThrow(AggregateError);
    expect(() => statSync(path.join(item.root, 'good'))).toThrow();
    expect(readFileSync(path.join(item.root, 'outside/b'), 'utf8')).toBe('foreign');
    expect(readFileSync(path.join(item.root, 'retained/b'), 'utf8')).toBe('owned');
  } finally {
    item.close();
  }
});

test('empty directory modes are published on held created directories and cleanup recovers access', () => {
  const item = fixture();
  try {
    mkdirSync(path.join(item.root, 'caller'));
    item.directory.directory('empty');
    item.directory.directory('nested/empty');
    item.directory.setDirectoryMode('empty', 0o500);
    item.directory.setDirectoryMode('nested', 0o555);
    item.directory.setDirectoryMode('', 0o700);
    item.directory.verifyDirectory('empty');
    item.directory.verifyDirectory('nested');
    item.directory.verifyDirectory('');
    expect(statSync(path.join(item.root, 'empty')).mode & 0o777).toBe(0o500);
    item.directory.directory('caller');
    expect(() => item.directory.setDirectoryMode('caller', 0o700)).toThrow('caller-owned');
    item.directory.removeCreated();
    expect(statSync(path.join(item.root, 'caller')).isDirectory()).toBe(true);
    expect(() => statSync(path.join(item.root, 'empty'))).toThrow();
  } finally {
    item.close();
  }
});

test('read-only capability captures exact existing bytes and never creates missing parents', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'read-only-files-'));
  mkdirSync(path.join(root, 'nested'));
  const content = Buffer.from([0, 255, 65, 10]);
  writeFileSync(path.join(root, 'nested/output'), content);
  const directory = openReadOnlyDirectory(root);
  try {
    const captured = directory.read('nested/output');
    expect(captured.bytes).toEqual(content);
    expect(captured.size).toBe(content.length);
    expect(captured.sha256).toHaveLength(64);
    directory.verify('nested/output');
    expect(directory.read('nested/output')).toEqual(captured);
    expect(() => directory.read('missing/output')).toThrow();
    expect(() => statSync(path.join(root, 'missing'))).toThrow();
    expect('write' in directory).toBe(false);
    expect('removeCreated' in directory).toBe(false);
    directory.close();
    expect(() => directory.read('nested/output')).toThrow('closed');
  } finally {
    directory.close();
    rmSync(root, { recursive: true });
  }
});

test('read-only capability refuses aliases, replaced parents and changed retained bytes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'read-only-files-'));
  mkdirSync(path.join(root, 'nested'));
  mkdirSync(path.join(root, 'foreign'));
  writeFileSync(path.join(root, 'nested/output'), 'original');
  writeFileSync(path.join(root, 'foreign/output'), 'foreign!');
  symlinkSync(path.join(root, 'foreign/output'), path.join(root, 'alias'));
  symlinkSync(path.join(root, 'foreign'), path.join(root, 'parent-alias'));
  const directory = openReadOnlyDirectory(root);
  try {
    for (const member of ['alias', 'parent-alias/output', '../foreign/output', '/absolute'])
      expect(() => directory.read(member)).toThrow();
    expect(directory.read('nested/output').bytes.toString()).toBe('original');
    writeFileSync(path.join(root, 'nested/output'), 'changed!');
    expect(() => directory.verify('nested/output')).toThrow('bytes changed');
    renameSync(path.join(root, 'nested'), path.join(root, 'retained'));
    symlinkSync(path.join(root, 'foreign'), path.join(root, 'nested'));
    expect(() => directory.read('nested/output')).toThrow('namespace changed');
    expect(readFileSync(path.join(root, 'foreign/output'), 'utf8')).toBe('foreign!');
  } finally {
    directory.close();
    rmSync(root, { recursive: true });
  }
});
