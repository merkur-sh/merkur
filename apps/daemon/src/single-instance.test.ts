import { dlopen, FFIType } from 'bun:ffi';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as fileLock from '@merkur/config/file-lock';
import { Effect, Exit, Scope } from 'effect';
import { createLogger } from './logger';
import { execDaemonOwner } from './services/owner-exec';
import {
  acquireDaemonInstanceLockEffect,
  DaemonAlreadyRunningError,
  readLockPidEffect,
} from './single-instance';

const logger = createLogger('single-instance-test');
let lockDir: string;
let lockPath: string;
beforeEach(async () => {
  lockDir = await mkdtemp(path.join(tmpdir(), 'merkur-lock-'));
  lockPath = path.join(lockDir, 'daemon.lock');
});
afterEach(async () => {
  await rm(lockDir, { recursive: true, force: true });
});

async function acquireScoped(): Promise<void> {
  await Effect.runPromise(
    Effect.scoped(acquireDaemonInstanceLockEffect(lockPath, logger)).pipe(Effect.asVoid),
  );
}

function deferred() {
  let resolve: () => void = () => {
    throw new Error('Deferred not initialized');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function spawnOwner(mode = 'hold') {
  return Bun.spawn(
    [
      process.execPath,
      new URL('./single-instance-lock-fixture.ts', import.meta.url).pathname,
      mode,
    ],
    {
      env: { ...process.env, LOG_LEVEL: 'silent', LOCK_FIXTURE_PATH: lockPath },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

async function marker(reader: ReadableStreamDefaultReader<Uint8Array>, name: string) {
  const line = new TextDecoder().decode((await reader.read()).value).trim();
  expect(line.startsWith(`${name} `)).toBe(true);
  return line.split(' ').slice(1);
}

test('instance_lock excludes a second owner before PID publication', async () => {
  const entered = deferred();
  const resume = deferred();
  let first = true;
  const pause = async () => {
    if (!first) return;
    first = false;
    entered.resolve();
    await resume.promise;
  };
  const open = filesystem.open;
  const openSpy = spyOn(filesystem, 'open').mockImplementation(async (filename, flags, mode) => {
    const handle = await open(filename, flags, mode);
    if (filename === lockPath) {
      const write = handle.writeFile.bind(handle);
      spyOn(handle, 'writeFile').mockImplementation(async (...args) => {
        await pause();
        return write(...args);
      });
    }
    return handle;
  });
  const flock = fileLock.lockFileDescriptor;
  const flockSpy = spyOn(fileLock, 'lockFileDescriptor').mockImplementation(async (...args) => {
    await flock(...args);
    await pause();
  });
  const a = Scope.makeUnsafe();
  const b = Scope.makeUnsafe();
  const acquire = (scope: Scope.Closeable) =>
    Effect.runPromise(
      acquireDaemonInstanceLockEffect(lockPath, logger).pipe(Scope.provide(scope)),
    ).then(
      () => true,
      () => false,
    );
  const pending = acquire(a);
  try {
    await entered.promise;
    const second = await acquire(b);
    resume.resolve();
    const first = await pending;
    process.stdout.write(
      `${JSON.stringify({ workload: 'publication-race', owners: Number(first) + Number(second) })}\n`,
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  } finally {
    resume.resolve();
    await pending;
    openSpy.mockRestore();
    flockSpy.mockRestore();
    await Effect.runPromise(Scope.close(a, Exit.void));
    await Effect.runPromise(Scope.close(b, Exit.void));
  }
});

test('instance_lock keeps one inode across release and ignores stale live PID text', async () => {
  await writeFile(lockPath, '1\n', { mode: 0o600 });
  const inode = (await stat(lockPath)).ino;
  await acquireScoped();
  expect((await stat(lockPath)).ino).toBe(inode);
  expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
  await acquireScoped();
  expect((await stat(lockPath)).ino).toBe(inode);
});

test('instance_lock excludes duplicates, releases on SIGKILL and preserves the inode', async () => {
  const child = spawnOwner();
  try {
    await marker(child.stdout.getReader(), 'locked');
    const inode = (await stat(lockPath)).ino;
    const error = await Effect.runPromise(
      acquireDaemonInstanceLockEffect(lockPath, logger).pipe(Effect.scoped, Effect.flip),
    );
    expect(error).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((error as DaemonAlreadyRunningError).pid).toBe(child.pid);
    child.kill('SIGKILL');
    await child.exited;
    await acquireScoped();
    expect((await stat(lockPath)).ino).toBe(inode);
    process.stdout.write(
      `${JSON.stringify({ workload: 'duplicate-and-death', busy: 1, recovered: 1 })}\n`,
    );
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
});

test('instance_lock remains held across the actual convergence exec and adopts the exact fd', async () => {
  const child = spawnOwner('exec');
  const output = child.stdout.getReader();
  try {
    const [pid, fd] = await marker(output, 'locked');
    const inode = (await stat(lockPath)).ino;
    child.stdin.write('x');
    const [inheritedPid, inheritedFd] = await marker(output, 'inherited');
    expect(inheritedPid).toBe(pid);
    expect(inheritedFd).toBe(fd);
    await expect(acquireScoped()).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    child.stdin.write('a');
    const [adoptedPid, adoptedFd] = await marker(output, 'adopted');
    expect(adoptedPid).toBe(pid);
    expect(fd).not.toBe('undefined');
    expect(adoptedFd).toBe(fd);
    expect((await stat(lockPath)).ino).toBe(inode);
    await expect(acquireScoped()).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    expect(await readFile(lockPath, 'utf8')).toBe(`${pid}\n`);
    process.stdout.write(
      `${JSON.stringify({ workload: 'owner-exec', samePid: 1, sameFd: 1, sameInode: 1, busy: 1 })}\n`,
    );
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
});

test('instance_lock closes its acquisition descriptor when PID publication fails', async () => {
  const open = filesystem.open;
  const openSync = fs.openSync;
  let descriptor: number | undefined;
  const openSpy = spyOn(filesystem, 'open').mockImplementation(async (filename, flags, mode) => {
    const handle = await open(filename, flags, mode);
    if (filename === lockPath) {
      descriptor = handle.fd;
      spyOn(handle, 'writeFile').mockRejectedValue(new Error('injected PID write failure'));
    }
    return handle;
  });
  const openSyncSpy = spyOn(fs, 'openSync').mockImplementation((...args) => {
    const fd = openSync(...args);
    if (args[0] === lockPath) descriptor = fd;
    return fd;
  });
  const writeSpy = spyOn(fs, 'writeSync').mockImplementation(() => {
    throw new Error('injected PID write failure');
  });
  try {
    await expect(acquireScoped()).rejects.toThrow('injected PID write failure');
    if (descriptor === undefined) throw new Error('Acquisition did not open a descriptor');
    let retained = 0;
    try {
      fs.fstatSync(descriptor);
      retained = 1;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBADF') throw error;
    }
    process.stdout.write(
      `${JSON.stringify({ workload: 'failed-publication', retainedDescriptors: retained })}\n`,
    );
    expect(retained).toBe(0);
  } finally {
    openSpy.mockRestore();
    openSyncSpy.mockRestore();
    writeSpy.mockRestore();
    if (descriptor !== undefined) closeTestDescriptor(descriptor);
  }

  await acquireScoped();
});

function closeTestDescriptor(descriptor: number) {
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBADF') throw error;
  }
}

test('instance_lock profiles ordinary startup, PID diagnostics and release', async () => {
  const counts = {
    open: 0,
    write: 0,
    truncate: 0,
    close: 0,
    read: 0,
    unlink: 0,
    stat: 0,
    flock: 0,
  };
  const open = filesystem.open;
  const openSpy = spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    counts.open += 1;
    const handle = await open(...args);
    const write = handle.writeFile.bind(handle);
    const close = handle.close.bind(handle);
    spyOn(handle, 'writeFile').mockImplementation(async (...args) => {
      counts.write += 1;
      return write(...args);
    });
    spyOn(handle, 'close').mockImplementation(async () => {
      counts.close += 1;
      return close();
    });
    return handle;
  });
  const tracked = {
    openSync: spyOn(fs, 'openSync'),
    writeSync: spyOn(fs, 'writeSync'),
    ftruncateSync: spyOn(fs, 'ftruncateSync'),
    closeSync: spyOn(fs, 'closeSync'),
    fstatSync: spyOn(fs, 'fstatSync'),
    statSync: spyOn(fs, 'statSync'),
    readFile: spyOn(filesystem, 'readFile'),
    unlink: spyOn(filesystem, 'unlink'),
    flock: spyOn(fileLock, 'lockFileDescriptor'),
  };
  const scope = Scope.makeUnsafe();
  try {
    await Effect.runPromise(
      acquireDaemonInstanceLockEffect(lockPath, logger).pipe(Scope.provide(scope)),
    );
    expect(await Effect.runPromise(readLockPidEffect(lockPath))).toBe(process.pid);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    counts.open += tracked.openSync.mock.calls.length;
    counts.write += tracked.writeSync.mock.calls.length;
    counts.truncate += tracked.ftruncateSync.mock.calls.length;
    counts.close += tracked.closeSync.mock.calls.length;
    counts.read += tracked.readFile.mock.calls.length;
    counts.unlink += tracked.unlink.mock.calls.length;
    counts.stat += tracked.fstatSync.mock.calls.length + tracked.statSync.mock.calls.length;
    counts.flock += tracked.flock.mock.calls.length;
    process.stdout.write(
      `${JSON.stringify({ workload: 'startup-diagnostic-release', ...counts })}\n`,
    );
    expect(counts.write).toBe(1);
  } finally {
    openSpy.mockRestore();
    for (const spy of Object.values(tracked)) spy.mockRestore();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

test('instance_lock proves Bun open uses CLOEXEC and process.execve closes even a cleared descriptor', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('./services/owner-exec-fixture.ts', import.meta.url).pathname,
      lockPath,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [status, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ status, error }).toEqual({ status: 0, error: '' });
  expect(
    output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([{ openCloexec: 1, clearedCloexec: 0 }, { retained: false }]);
  process.stdout.write(output);
});

test('instance_lock preserves ownership and CLOEXEC when native exec fails', async () => {
  const native = dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    {
      fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    },
  );
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const descriptor = yield* acquireDaemonInstanceLockEffect(lockPath, logger);
          expect(native.symbols.fcntl(descriptor, 1) & 1).toBe(1);
          expect(() =>
            execDaemonOwner(path.join(lockDir, 'absent'), ['absent'], {}, descriptor),
          ).toThrow('Owner exec failed');
          expect(native.symbols.fcntl(descriptor, 1) & 1).toBe(1);
          yield* Effect.promise(async () => {
            await expect(acquireScoped()).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
          });
          // A normal child must not prolong the lock after its owner scope closes.
          child = Bun.spawn(
            [process.execPath, '-e', "process.stdout.write('ready\\n'); await Bun.stdin.text()"],
            {
              stdin: 'pipe',
              stdout: 'pipe',
            },
          );
          const output = child.stdout;
          yield* Effect.promise(async () => {
            if (!(output instanceof ReadableStream)) throw new Error('Missing child output');
            expect(new TextDecoder().decode((await output.getReader().read()).value)).toBe(
              'ready\n',
            );
          });
        }),
      ),
    );
    expect(child?.exitCode).toBeNull();
    await acquireScoped();
  } finally {
    native.close();
    child?.kill('SIGKILL');
    if (child !== undefined) await child.exited;
  }
});

test('instance_lock compiled owner embeds the worker and retains ownership across convergence', async () => {
  const executable = path.join(lockDir, 'compiled-owner');
  const build = Bun.spawn(
    [
      process.execPath,
      'build',
      new URL('./single-instance-lock-fixture.ts', import.meta.url).pathname,
      new URL('../../../packages/config/src/daemon-config-lock-worker.ts', import.meta.url)
        .pathname,
      '--compile',
      '--entry-naming',
      '[name].[ext]',
      '--outfile',
      executable,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [status, error] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  expect({ status, error: status === 0 ? '' : error }).toEqual({ status: 0, error: '' });
  const child = Bun.spawn([executable, 'compiled-exec'], {
    env: { ...process.env, LOG_LEVEL: 'silent', LOCK_FIXTURE_PATH: lockPath },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = child.stdout.getReader();
  try {
    const before = await marker(output, 'locked');
    child.stdin.write('x');
    expect(await marker(output, 'inherited')).toEqual(before);
    await expect(acquireScoped()).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    child.stdin.write('a');
    expect(await marker(output, 'adopted')).toEqual(before);
    process.stdout.write(
      `${JSON.stringify({ workload: 'compiled-owner-exec', samePid: 1, sameFd: 1, busyBeforeAdoption: 1 })}\n`,
    );
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
});

test('instance_lock does not report an unlocked stale PID as a stop target', async () => {
  await writeFile(lockPath, '1\n', { mode: 0o600 });
  expect(await Effect.runPromise(readLockPidEffect(lockPath))).toBeNull();
  await acquireScoped();
  expect(await Effect.runPromise(readLockPidEffect(lockPath))).toBeNull();
  process.stdout.write(`${JSON.stringify({ workload: 'stale-stop-target', targets: 0 })}\n`);
});

test('instance_lock closes a foreign inherited descriptor and rejects symlink locks', async () => {
  await writeFile(lockPath, '');
  const other = fs.openSync(path.join(lockDir, 'other'), 'w+', 0o600);
  await expect(
    Effect.runPromise(Effect.scoped(acquireDaemonInstanceLockEffect(lockPath, logger, other))),
  ).rejects.toThrow('does not name the instance lock');
  expect(() => fs.fstatSync(other)).toThrow();
  await filesystem.symlink(lockPath, path.join(lockDir, 'symlink'));
  await expect(
    Effect.runPromise(
      Effect.scoped(acquireDaemonInstanceLockEffect(path.join(lockDir, 'symlink'), logger)),
    ),
  ).rejects.toThrow();
  await acquireScoped();
});
