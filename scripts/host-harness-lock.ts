import { dlopen, FFIType } from 'bun:ffi';
import { openSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * One browser harness per host. The edge harness's latency phase asserts GPU-fenced
 * millisecond budgets that assume an otherwise idle machine, and two harnesses at once
 * also share the GPU and the build: overlapping runs failed into timeouts instead of
 * queueing. A second run waits for the first. The lock is the kernel's `flock` on an
 * open descriptor the process never closes, so it is released however the holder
 * exits and a crashed run leaves nothing behind to clean up.
 */
export const HOST_HARNESS_LOCK = '/tmp/merkur-browser-harness.lock';

const LOCK_EX = 2;
const LOCK_NB = 4;
/** `flock` offers no wake-up when a holder exits; a waiting harness re-asks. */
const RETRY_MS = 500;

const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

export async function acquireHostHarnessLock(
  label: string,
  lockPath = HOST_HARNESS_LOCK,
): Promise<void> {
  const descriptor = openSync(lockPath, 'a+');
  let announced = false;
  while (libc.symbols.flock(descriptor, LOCK_EX | LOCK_NB) !== 0) {
    if (!announced) {
      const holder = readFileSync(lockPath, 'utf8').trim();
      process.stderr.write(
        `[harness] waiting for the browser harness this host is running: ${holder}\n`,
      );
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  writeFileSync(lockPath, `pid ${process.pid}: ${label}\n`);
}
