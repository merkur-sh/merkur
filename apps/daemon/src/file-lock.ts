import { dlopen, FFIType } from 'bun:ffi';
import { type FileHandle, open } from 'node:fs/promises';

const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/** The stable inode is never unlinked. Closing the descriptor releases ownership. */
export async function tryAcquireFileLock(
  lockPath: string,
  mode: 'shared' | 'exclusive',
): Promise<FileHandle | null> {
  // Bun's node:fs opens descriptors close-on-exec; children must not prolong ownership.
  const handle = await open(lockPath, 'a+', 0o600);
  try {
    // LOCK_SH/LOCK_EX | LOCK_NB on both supported operating systems. Fail closed.
    if (libc.symbols.flock(handle.fd, (mode === 'shared' ? 1 : 2) | 4) === 0) return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return null;
}
