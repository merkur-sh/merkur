import { dlopen, FFIType, ptr, read } from 'bun:ffi';
import { readdirSync } from 'node:fs';

const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
// These ioctls need no variadic argument, whose ABI differs on Darwin arm64.
const FIOCLEX = process.platform === 'darwin' ? 0x20006601 : 0x5451;
const FIONCLEX = process.platform === 'darwin' ? 0x20006602 : 0x5450;

export function closeInstanceLockOnExec(descriptor: number): void {
  const native = dlopen(library, {
    fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  });
  try {
    const flags = native.symbols.fcntl(descriptor, 1);
    if (flags < 0 || native.symbols.ioctl(descriptor, FIOCLEX) < 0) {
      throw new Error('Cannot mark inherited daemon lock close-on-exec');
    }
  } finally {
    native.close();
  }
}

function nativeStrings(values: readonly string[]) {
  const buffers = values.map((value) => {
    if (value.includes('\0')) throw new Error('Owner exec argument contains NUL');
    return Buffer.from(`${value}\0`);
  });
  const pointers = new BigUint64Array(buffers.length + 1);
  for (const [index, buffer] of buffers.entries()) pointers[index] = BigInt(ptr(buffer));
  return { buffers, pointers };
}

/** Bun's process.execve closes every fd above 2, including explicitly inherited locks. */
export function execDaemonOwner(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  descriptor: number,
): never {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) throw new Error('Missing daemon lock');
  const executable = nativeStrings([file]);
  const argv = nativeStrings(args);
  const envp = nativeStrings(
    Object.entries(env).flatMap(([key, value]) => {
      if (key.includes('=')) throw new Error('Owner exec environment key contains =');
      return value === undefined ? [] : [`${key}=${value}`];
    }),
  );
  try {
    if (process.platform === 'darwin') {
      return execDarwin(executable.buffers[0], argv.pointers, envp.pointers, descriptor);
    }
    return execLinux(executable.buffers[0], argv.pointers, envp.pointers, descriptor);
  } finally {
    // Keep the pointed-to strings alive across the native call, including its failure path.
    for (const buffer of [...executable.buffers, ...argv.buffers, ...envp.buffers]) buffer.fill(0);
  }
}

function execDarwin(
  file: Buffer | undefined,
  argv: BigUint64Array,
  envp: BigUint64Array,
  descriptor: number,
): never {
  if (file === undefined) throw new Error('Missing owner executable');
  const native = dlopen(library, {
    posix_spawn: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    posix_spawnattr_init: { args: [FFIType.ptr], returns: FFIType.i32 },
    posix_spawnattr_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
    posix_spawnattr_setflags: { args: [FFIType.ptr, FFIType.i16], returns: FFIType.i32 },
    posix_spawnattr_setsigmask: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    posix_spawn_file_actions_init: { args: [FFIType.ptr], returns: FFIType.i32 },
    posix_spawn_file_actions_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
    posix_spawn_file_actions_addinherit_np: {
      args: [FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  });
  // Darwin defines both opaque spawn handles as pointers and sigset_t as uint32_t.
  const attributes = new BigUint64Array(1);
  const actions = new BigUint64Array(1);
  const mask = new Uint32Array(1);
  const pid = new Int32Array(1);
  let attributesReady = false;
  let actionsReady = false;
  const flags = native.symbols.fcntl(descriptor, 1);
  const check = (code: number) => {
    if (code !== 0) throw new Error(`Owner exec failed: errno ${code}`);
  };
  try {
    if (flags < 0 || native.symbols.ioctl(descriptor, FIONCLEX) < 0)
      throw new Error('Cannot inherit daemon lock');
    check(native.symbols.posix_spawnattr_init(ptr(attributes)));
    attributesReady = true;
    check(native.symbols.posix_spawn_file_actions_init(ptr(actions)));
    actionsReady = true;
    // CLOEXEC_DEFAULT | SETEXEC | SETSIGMASK: retain exactly stdio and the lock.
    check(native.symbols.posix_spawnattr_setflags(ptr(attributes), 0x4000 | 0x0040 | 0x0008));
    check(native.symbols.posix_spawnattr_setsigmask(ptr(attributes), ptr(mask)));
    for (const fd of [0, 1, 2, descriptor])
      check(native.symbols.posix_spawn_file_actions_addinherit_np(ptr(actions), fd));
    check(
      native.symbols.posix_spawn(
        ptr(pid),
        ptr(file),
        ptr(actions),
        ptr(attributes),
        ptr(argv),
        ptr(envp),
      ),
    );
    throw new Error('Owner exec returned without replacing the process');
  } finally {
    if (actionsReady) native.symbols.posix_spawn_file_actions_destroy(ptr(actions));
    if (attributesReady) native.symbols.posix_spawnattr_destroy(ptr(attributes));
    if (flags >= 0) native.symbols.ioctl(descriptor, flags & 1 ? FIOCLEX : FIONCLEX);
    native.close();
  }
}

function execLinux(
  file: Buffer | undefined,
  argv: BigUint64Array,
  envp: BigUint64Array,
  descriptor: number,
): never {
  if (file === undefined) throw new Error('Missing owner executable');
  const native = dlopen(library, {
    execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
    pthread_sigmask: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  // glibc sigset_t is 1024 bits on both supported Linux architectures.
  const mask = new BigUint64Array(16);
  const previous = new BigUint64Array(16);
  let maskChanged = false;
  const flags = native.symbols.fcntl(descriptor, 1);
  const errno = () => {
    const location = native.symbols.__errno_location();
    if (location === null) throw new Error('Cannot read owner exec errno');
    return read.i32(location);
  };
  try {
    if (flags < 0) throw new Error('Invalid daemon lock descriptor');
    // Concurrent Bun opens use O_CLOEXEC. Also mark descriptors inherited from the launcher.
    for (const name of readdirSync('/proc/self/fd')) {
      const fd = Number(name);
      const current = native.symbols.fcntl(fd, 1);
      if (current < 0) {
        if (errno() === 9) continue; // The directory read has closed its own descriptor.
        throw new Error(`Cannot inspect owner descriptor ${fd}`);
      }
      const request = fd <= 2 || fd === descriptor ? FIONCLEX : FIOCLEX;
      if (native.symbols.ioctl(fd, request) < 0)
        throw new Error(`Cannot prepare owner descriptor ${fd}`);
    }
    const code = native.symbols.pthread_sigmask(2, ptr(mask), ptr(previous));
    if (code !== 0) throw new Error(`Cannot reset owner signal mask: errno ${code}`);
    maskChanged = true;
    native.symbols.execve(ptr(file), ptr(argv), ptr(envp));
    throw new Error(`Owner exec failed: errno ${errno()}`);
  } finally {
    if (maskChanged) native.symbols.pthread_sigmask(2, ptr(previous), null);
    if (flags >= 0) native.symbols.ioctl(descriptor, flags & 1 ? FIOCLEX : FIONCLEX);
    native.close();
  }
}
