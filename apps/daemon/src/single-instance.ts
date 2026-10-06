import { type FileHandle, open, readFile, unlink } from 'node:fs/promises';
import { normalizeUnknownError } from '@merkur/shared';
import { Effect, type Scope } from 'effect';

import type { Logger } from './logger';
import {
  isFileExistsError,
  isMissingFileError,
  isProcessAlive,
  readPositivePidFile,
} from './process-utils';

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
  const lockBody = `${process.pid}\n`;

  return Effect.suspend(() =>
    openLockHandle(lockPath).pipe(
      Effect.flatMap((handle) =>
        writeLockBody(handle, lockBody).pipe(
          Effect.as(createReleaseLock(lockPath, lockBody, handle, logger)),
        ),
      ),
      Effect.catch((error: Error) => {
        if (!isFileExistsError(error)) {
          return Effect.fail(error);
        }

        return Effect.gen(function* () {
          const existingPid = yield* readLockPidEffect(lockPath);
          // A lock holding our own pid is always stale: no other live process
          // can share our pid, so it is a leftover from a previous in-place
          // re-exec (e.g. `bun --watch` reuses the pid and skips finalizers) or
          // from pid reuse after the original holder died. Reclaim it rather
          // than refusing to start.
          const isOwnStaleLock = existingPid === process.pid;
          if (existingPid !== null && !isOwnStaleLock && isProcessAlive(existingPid)) {
            return yield* Effect.fail(new DaemonAlreadyRunningError(lockPath, existingPid));
          }

          logger.warn('daemon_stale_lock_removed', {
            lockPath,
            pid: existingPid,
          });
          yield* removeLockFileEffect(lockPath);
          return yield* acquireDaemonInstanceLock(lockPath, logger);
        });
      }),
    ),
  );
}

function openLockHandle(lockPath: string): Effect.Effect<FileHandle, Error> {
  return Effect.tryPromise({
    try: () => open(lockPath, 'wx', 0o600),
    catch: normalizeUnknownError,
  });
}

function writeLockBody(handle: FileHandle, lockBody: string): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () => handle.writeFile(lockBody, 'utf8'),
    catch: normalizeUnknownError,
  });
}

export function removeLockFileEffect(lockPath: string): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () => unlink(lockPath),
    catch: normalizeUnknownError,
  }).pipe(
    Effect.catch((error: Error) => (isMissingFileError(error) ? Effect.void : Effect.fail(error))),
  );
}

function createReleaseLock(
  lockPath: string,
  lockBody: string,
  handle: FileHandle,
  logger: Logger,
): () => Promise<void> {
  let released = false;

  return async () => {
    if (released) {
      return;
    }
    released = true;

    await handle.close();

    try {
      const currentLockBody = await readFile(lockPath, 'utf8');
      if (currentLockBody === lockBody) {
        await unlink(lockPath);
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        logger.warn('daemon_lock_release_failed', {
          lockPath,
          error: String(error),
        });
      }
    }
  };
}

export function readLockPidEffect(lockPath: string): Effect.Effect<number | null, Error> {
  return Effect.tryPromise({
    try: () => readPositivePidFile(lockPath),
    catch: normalizeUnknownError,
  });
}
