import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  statSync,
  writeSync,
} from 'node:fs';
import { FileLockBusyError, lockFileDescriptor } from '@merkur/config/file-lock';
import { normalizeUnknownError } from '@merkur/shared';
import { Effect, type Scope } from 'effect';

import type { Logger } from './logger';
import { isMissingFileError, readPositivePidFile } from './process-utils';

export const DAEMON_INSTANCE_LOCK_FD_ENV = 'MERKUR_DAEMON_LOCK_FD';

export class DaemonAlreadyRunningError extends Error {
  constructor(
    readonly lockPath: string,
    readonly pid: number | null,
  ) {
    super(
      pid === null
        ? `Another daemon instance is already running (${lockPath})`
        : `Another daemon instance is already running with pid ${pid} (${lockPath})`,
    );
  }
}

/** Consume before any child can inherit the predecessor's descriptor announcement. */
export async function takeDaemonInstanceLockDescriptor(): Promise<number | null> {
  const value = process.env[DAEMON_INSTANCE_LOCK_FD_ENV];
  delete process.env[DAEMON_INSTANCE_LOCK_FD_ENV];
  if (value === undefined) return null;
  const descriptor = Number(value);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || String(descriptor) !== value) {
    throw new Error('Invalid inherited daemon lock descriptor');
  }
  const { closeInstanceLockOnExec } = await import('./services/owner-exec');
  closeInstanceLockOnExec(descriptor);
  return descriptor;
}

export function acquireDaemonInstanceLockEffect(
  lockPath: string,
  logger: Logger,
  inheritedDescriptor: number | null = null,
): Effect.Effect<number, Error, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquireInstanceLock(lockPath, inheritedDescriptor),
      catch: normalizeUnknownError,
    }),
    (descriptor) =>
      Effect.sync(() => {
        try {
          closeSync(descriptor);
        } catch (error) {
          logger.warn('daemon_lock_release_failed', { lockPath, error: String(error) });
        }
      }),
  );
}

async function acquireInstanceLock(lockPath: string, inheritedDescriptor: number | null) {
  const descriptor =
    inheritedDescriptor ??
    openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const actual = fstatSync(descriptor, { bigint: true });
    const expected = statSync(lockPath, { bigint: true });
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error('Inherited daemon lock descriptor does not name the instance lock');
    }
    try {
      await lockFileDescriptor(descriptor, 6);
    } catch (error) {
      if (!(error instanceof FileLockBusyError)) throw error;
      throw new DaemonAlreadyRunningError(lockPath, await readPositivePidFile(lockPath));
    }
    const body = Buffer.from(`${process.pid}\n`);
    ftruncateSync(descriptor, 0);
    let offset = 0;
    while (offset < body.byteLength) {
      const written = writeSync(descriptor, body, offset, body.byteLength - offset, offset);
      if (written === 0) throw new Error('Daemon PID write made no progress');
      offset += written;
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function readLockPidEffect(lockPath: string): Effect.Effect<number | null, Error> {
  return Effect.tryPromise({
    try: async () => {
      let descriptor: number;
      try {
        descriptor = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
      try {
        try {
          await lockFileDescriptor(descriptor, 6);
          return null;
        } catch (error) {
          if (!(error instanceof FileLockBusyError)) throw error;
          return await readPositivePidFile(lockPath);
        }
      } finally {
        closeSync(descriptor);
      }
    },
    catch: normalizeUnknownError,
  });
}
