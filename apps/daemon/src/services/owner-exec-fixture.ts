import { dlopen, FFIType } from 'bun:ffi';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { lockFileDescriptor } from '@merkur/config/file-lock';

const [lockPath, inherited] = process.argv.slice(2);
if (lockPath === undefined) throw new Error('Missing control lock path');
if (inherited !== undefined) {
  let retained = false;
  try {
    const [fd, dev, ino] = inherited.split(':');
    const actual = fstatSync(Number(fd), { bigint: true });
    retained = String(actual.dev) === dev && String(actual.ino) === ino;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBADF') throw error;
  }
  process.stdout.write(`${JSON.stringify({ retained })}\n`);
} else {
  const descriptor = openSync(lockPath, 'w+', 0o600);
  await lockFileDescriptor(descriptor, 6);
  const native = dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    {
      fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
    },
  );
  const before = native.symbols.fcntl(descriptor, 1);
  if (
    before < 0 ||
    native.symbols.ioctl(descriptor, process.platform === 'darwin' ? 0x20006602 : 0x5450) !== 0
  )
    throw new Error('Cannot clear CLOEXEC');
  process.stdout.write(
    `${JSON.stringify({ openCloexec: before & 1, clearedCloexec: native.symbols.fcntl(descriptor, 1) & 1 })}\n`,
  );
  native.close();
  if (process.execve === undefined) throw new Error('Missing process.execve');
  try {
    process.execve(
      process.execPath,
      [
        process.execPath,
        import.meta.path,
        lockPath,
        `${descriptor}:${fstatSync(descriptor, { bigint: true }).dev}:${fstatSync(descriptor, { bigint: true }).ino}`,
      ],
      process.env,
    );
  } finally {
    closeSync(descriptor);
  }
}
