import { dlopen, FFIType, read } from 'bun:ffi';
import { workerData } from 'node:worker_threads';
import { Schema } from 'effect';

// flock belongs to the open file description in the parent. A blocking acquisition
// runs on this thread so another process's config write cannot stall the daemon.
const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const lock = dlopen(library, {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const errno =
  process.platform === 'darwin'
    ? dlopen(library, { __error: { args: [], returns: FFIType.ptr } })
    : dlopen(library, { __errno_location: { args: [], returns: FFIType.ptr } });
try {
  const { descriptor, operation } = Schema.decodeUnknownSync(
    Schema.Struct({
      descriptor: Schema.Int,
      operation: Schema.Literals([2, 6]),
    }),
  )(workerData);
  if (descriptor < 0) throw new Error('Invalid config lock descriptor');
  // LOCK_EX, LOCK_NB and EINTR have these values on both supported operating systems.
  while (lock.symbols.flock(descriptor, operation) !== 0) {
    const location =
      '__error' in errno.symbols ? errno.symbols.__error() : errno.symbols.__errno_location();
    if (location === null) throw new Error('Cannot read config lock error');
    const code = read.i32(location);
    if (operation === 6 && code === (process.platform === 'darwin' ? 35 : 11)) {
      throw new Error('Another daemon link is already in progress');
    }
    if (code !== 4) throw new Error(`Cannot acquire config lock: errno ${code}`);
  }
} finally {
  errno.close();
  lock.close();
}
