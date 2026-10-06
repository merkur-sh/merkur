import { afterEach, beforeEach, expect, test } from 'bun:test';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';

import { createLogger } from './logger';
import { acquireDaemonInstanceLockEffect, DaemonAlreadyRunningError } from './single-instance';

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
  await Effect.runPromise(Effect.scoped(acquireDaemonInstanceLockEffect(lockPath, logger)));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('acquires a fresh lock and releases it when the scope closes', async () => {
  await acquireScoped();
  // The scoped finalizer removes the lock file we created.
  expect(await fileExists(lockPath)).toBe(false);
});

test('release preserves a replacement lock with a different byte representation', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireDaemonInstanceLockEffect(lockPath, logger);
        yield* Effect.promise(() => writeFile(lockPath, `\uFEFF${process.pid}\n`, 'utf8'));
      }),
    ),
  );
  expect(await fileExists(lockPath)).toBe(true);
});

test('reclaims a lock left behind by a previous re-exec (same pid)', async () => {
  // Simulates `bun --watch` re-execing in place: the lock file persists with
  // our own pid because finalizers never ran on the previous run.
  await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 });
  await expect(acquireScoped()).resolves.toBeUndefined();
});

test('removes a stale lock whose pid is not alive', async () => {
  // 2^31 - 2 is effectively never a live pid on these platforms.
  await writeFile(lockPath, '2147483646\n', { mode: 0o600 });
  await expect(acquireScoped()).resolves.toBeUndefined();
});

test('refuses to start when another live process holds the lock', async () => {
  // pid 1 (launchd/init) is always alive; signalling it yields EPERM, which
  // isProcessAlive treats as alive.
  await writeFile(lockPath, '1\n', { mode: 0o600 });
  let caught: unknown;
  try {
    await acquireScoped();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DaemonAlreadyRunningError);
  expect((caught as DaemonAlreadyRunningError).pid).toBe(1);
});
