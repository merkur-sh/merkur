import { dlopen, FFIType } from 'bun:ffi';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';

import type { DaemonConfig } from './config';
import { createLogger, MerkurLoggerLayer } from './logger';
import { convergeEffect } from './services/daemon-convergence';
import * as locks from './single-instance';

const lockPath = process.env.LOCK_FIXTURE_PATH;
if (lockPath === undefined) throw new Error('Missing fixture lock path');
const adopted = process.env.MERKUR_DATAPLANE_ADOPT !== undefined;
const descriptor = (await locks.takeDaemonInstanceLockDescriptor()) ?? null;
const logger = createLogger('instance-lock-fixture');
async function resume() {
  const reader = Bun.stdin.stream().getReader();
  try {
    await reader.read();
  } finally {
    reader.releaseLock();
  }
}
if (adopted) {
  if (descriptor === null) throw new Error('Missing inherited descriptor');
  const native = dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    {
      fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    },
  );
  try {
    if ((native.symbols.fcntl(descriptor, 1) & 1) !== 1)
      throw new Error('Adopted lock lacks CLOEXEC');
  } finally {
    native.close();
  }
  const sentinel = process.env.LOCK_FIXTURE_SENTINEL;
  delete process.env.LOCK_FIXTURE_SENTINEL;
  if (sentinel === undefined) throw new Error('Missing descriptor isolation proof');
  const [fd, ino] = sentinel.split(':');
  let retained = false;
  try {
    retained = String(fstatSync(Number(fd), { bigint: true }).ino) === ino;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBADF') throw error;
  }
  if (retained) throw new Error('Exec retained an unrelated descriptor');
  process.stdout.write(`inherited ${process.pid} ${String(descriptor)}\n`);
  await resume();
}

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fd = yield* locks.acquireDaemonInstanceLockEffect(lockPath, logger, descriptor);
      process.stdout.write(`${adopted ? 'adopted' : 'locked'} ${process.pid} ${String(fd)}\n`);
      yield* Effect.promise(resume);
      if (adopted || !['exec', 'compiled-exec'].includes(process.argv[2] ?? '')) return;
      const installRoot = path.dirname(lockPath);
      const versionDirectory = path.join(installRoot, 'versions', 'v9.8.7');
      yield* Effect.promise(async () => {
        await mkdir(versionDirectory, { recursive: true });
        for (const name of ['merkur', 'merkur-dataplane', 'merkur-image-worker', 'merkur-tui']) {
          const file = path.join(versionDirectory, name);
          const source =
            name === 'merkur'
              ? `#!${process.execPath}\nimport ${JSON.stringify(import.meta.path)};\n`
              : '#!/bin/sh\n';
          if (name === 'merkur' && process.argv[2] === 'compiled-exec') {
            await copyFile(process.execPath, file);
          } else {
            await writeFile(file, source);
          }
          await chmod(file, 0o755);
        }
        await writeFile(
          path.join(versionDirectory, 'release-trust.json'),
          `${JSON.stringify({ manifestSha512: 'ab'.repeat(64), sequence: 42 })}\n`,
        );
      });
      const sentinel = openSync(path.join(installRoot, 'unrelated'), 'w+', 0o600);
      const native = dlopen(
        process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
        {
          ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
        },
      );
      try {
        if (
          native.symbols.ioctl(sentinel, process.platform === 'darwin' ? 0x20006602 : 0x5450) !== 0
        ) {
          throw new Error('Cannot prepare unrelated inherited descriptor');
        }
      } finally {
        native.close();
      }
      process.env.LOCK_FIXTURE_SENTINEL = `${sentinel}:${fstatSync(sentinel, { bigint: true }).ino}`;
      yield* Effect.addFinalizer(() => Effect.sync(() => closeSync(sentinel)));
      yield* convergeEffect(
        {
          // SAFETY: the supplied stager and upgrade stub need only the server origin.
          config: { server_origin: 'https://merkur.test' } as DaemonConfig,
          logger,
          installRoot,
          instanceLockDescriptor: fd,
          dataplane: {
            dataplanePid: () => process.pid,
            upgradeEffect: () => Effect.succeed({ status: 'accepted' as const }),
          },
        },
        { stage: () => Effect.succeed(versionDirectory), request: () => Effect.void },
        'v9.8.7',
      );
    }),
  ).pipe(Effect.provide(MerkurLoggerLayer)),
);
