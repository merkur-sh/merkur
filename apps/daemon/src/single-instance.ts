import { normalizeUnknownError } from '@merkur/shared';
import { Effect, type Scope } from 'effect';

import { tryAcquireFileLock } from './file-lock';
import type { Logger } from './logger';
import { readPositivePidFile } from './process-utils';

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

export function acquireDaemonInstanceLockEffect(
  lockPath: string,
  logger: Logger,
): Effect.Effect<void, Error, Scope.Scope> {
  return Effect.acquireRelease(acquireDaemonInstanceLock(lockPath, logger), (release) =>
    Effect.promise(() => release()),
  ).pipe(Effect.asVoid);
}

function acquireDaemonInstanceLock(
  lockPath: string,
  logger: Logger,
): Effect.Effect<() => Promise<void>, Error> {
  return Effect.tryPromise({
    try: async () => {
      const handle = await tryAcquireFileLock(lockPath, 'exclusive');
      if (handle === null) {
        throw new DaemonAlreadyRunningError(lockPath, await readPositivePidFile(lockPath));
      }
      try {
        await handle.truncate(0);
        await handle.writeFile(`${process.pid}\n`, 'utf8');
      } catch (error) {
        await handle.close();
        throw error;
      }
      return async () => {
        try {
          await handle.close();
        } catch (error) {
          logger.warn('daemon_lock_release_failed', { lockPath, error: String(error) });
        }
      };
    },
    catch: normalizeUnknownError,
  });
}

export function readLockPidEffect(lockPath: string): Effect.Effect<number | null, Error> {
  return Effect.tryPromise({
    try: async () => {
      const handle = await tryAcquireFileLock(lockPath, 'exclusive');
      if (handle === null) return readPositivePidFile(lockPath);
      await handle.close();
      return null;
    },
    catch: normalizeUnknownError,
  });
}
