import { dlopen, ptr } from 'bun:ffi';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Stats,
  writeFileSync,
  writeSync,
} from 'node:fs';

function systemLibrary(): string {
  if (process.platform === 'darwin') return '/usr/lib/libSystem.B.dylib';
  if (process.platform === 'linux' && process.arch === 'arm64')
    return '/lib/aarch64-linux-gnu/libc.so.6';
  if (process.platform === 'linux' && process.arch === 'x64')
    return '/lib/x86_64-linux-gnu/libc.so.6';
  throw new Error('Anchored publication requires a qualified native platform libc');
}

function syscalls() {
  return dlopen(systemLibrary(), {
    openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' },
    mkdirat: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
    unlinkat: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
    symlinkat: { args: ['ptr', 'i32', 'ptr'], returns: 'i32' },
    readlinkat: { args: ['i32', 'ptr', 'ptr', 'u64'], returns: 'i64' },
    fcntl: { args: ['i32', 'i32', 'i64'], returns: 'i32' },
  });
}

function components(relative: string): string[] {
  const result = relative.split('/');
  if (
    relative.includes('\0') ||
    relative.includes('\\') ||
    result.some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error('Anchored publication requires a portable relative path');
  return result;
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readBytes(fd: number, size: number): Buffer {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < content.byteLength) {
    const count = readSync(fd, content, offset, content.byteLength - offset, offset);
    if (count === 0) throw new Error('Anchored file became incomplete');
    offset += count;
  }
  return content;
}

interface Directory {
  readonly fd: number;
  readonly parent: number;
  readonly name: Buffer;
  readonly identity: Stats;
  readonly created: boolean;
  mode?: number;
}

interface File {
  readonly fd: number;
  readonly parent: number;
  readonly name: Buffer;
  readonly identity: Stats;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
  readonly target?: string;
}

/** The root is an explicitly engine-owned ordinary directory, opened once. */
export class OwnedDirectory {
  private readonly library = syscalls();
  private readonly directories = new Map<string, Directory>();
  private readonly files = new Map<string, File>();
  private readonly existingFiles = new Map<string, File>();
  private readonly directoryDescriptors = new Map<number, Directory>();
  private readonly descriptors: number[] = [];
  private readonly root: number;
  private closed = false;
  private rootMode: number | undefined;

  constructor(root: string) {
    try {
      this.root = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.descriptors.push(this.root);
    } catch (error) {
      this.library.close();
      throw error;
    }
  }

  private requireOpen() {
    if (this.closed) throw new Error('Owned directory capability is closed');
  }

  private verifyEntry(entry: Directory | File, flags: number) {
    const actual = this.library.symbols.openat(
      entry.parent,
      ptr(entry.name),
      flags | constants.O_NONBLOCK,
      0,
    );
    if (actual < 0) throw new Error('Owned publication namespace changed');
    try {
      const identity = fstatSync(actual);
      if (
        !sameInode(entry.identity, identity) ||
        entry.identity.isFile() !== identity.isFile() ||
        entry.identity.isDirectory() !== identity.isDirectory() ||
        entry.identity.isSymbolicLink() !== identity.isSymbolicLink()
      )
        throw new Error('Owned publication namespace changed');
    } finally {
      closeSync(actual);
    }
  }

  private verifyParents(fd: number) {
    let current = fd;
    while (current !== this.root) {
      const directory = this.directoryDescriptors.get(current);
      if (directory === undefined) throw new Error('Unknown owned directory capability');
      this.verifyEntry(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      current = directory.parent;
    }
  }

  private parent(relative: string, create: boolean) {
    this.requireOpen();
    const parts = components(relative);
    const member = parts.pop();
    if (member === undefined) throw new Error('Owned publication requires a member');
    let parent = this.root;
    let location = '';
    let verified = false;
    for (const part of parts) {
      location = location === '' ? part : `${location}/${part}`;
      const existing = this.directories.get(location);
      if (existing !== undefined) {
        parent = existing.fd;
        continue;
      }
      // The deepest retained ancestor's chain names every retained ancestor once.
      if (!verified) this.verifyParents(parent);
      verified = true;
      const name = Buffer.from(`${part}\0`);
      const created = create && this.library.symbols.mkdirat(parent, ptr(name), 0o755) === 0;
      const fd = this.library.symbols.openat(
        parent,
        ptr(name),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        0,
      );
      if (fd < 0) throw new Error('Owned publication parent must be an ordinary directory');
      this.descriptors.push(fd);
      const retained = { fd, parent, name, identity: fstatSync(fd), created };
      this.directories.set(location, retained);
      this.directoryDescriptors.set(fd, retained);
      parent = fd;
    }
    if (!verified) this.verifyParents(parent);
    return { parent, name: Buffer.from(`${member}\0`) };
  }

  directory(relative: string) {
    this.parent(`${relative}/.owned-directory-capability`, true);
  }

  setDirectoryMode(relative: string, mode: number) {
    this.requireOpen();
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777)
      throw new Error('Owned directory mode must be an explicit permission mode');
    const directory = relative === '' ? undefined : this.directories.get(relative);
    if (relative !== '' && (directory === undefined || !directory.created))
      throw new Error('Cannot change a caller-owned directory mode');
    const fd = directory?.fd ?? this.root;
    const before = fstatSync(fd);
    if (
      !before.isDirectory() ||
      (directory !== undefined && !sameInode(before, directory.identity))
    )
      throw new Error('Owned directory identity changed');
    if (directory !== undefined) this.verifyParents(directory.fd);
    fchmodSync(fd, mode);
    const after = fstatSync(fd);
    if (!sameInode(before, after) || (after.mode & 0o777) !== mode)
      throw new Error('Owned directory mode publication failed');
    if (directory === undefined) this.rootMode = mode;
    else directory.mode = mode;
  }

  verifyDirectory(relative: string) {
    this.requireOpen();
    const directory = relative === '' ? undefined : this.directories.get(relative);
    if (directory !== undefined) this.verifyParents(directory.fd);
    this.verifyDirectoryFacts(relative);
  }

  private verifyDirectoryFacts(relative: string) {
    const directory = relative === '' ? undefined : this.directories.get(relative);
    if (relative !== '' && directory === undefined)
      throw new Error('Cannot verify an unretained directory');
    const actual = fstatSync(directory?.fd ?? this.root);
    const mode = directory?.mode ?? (relative === '' ? this.rootMode : undefined);
    if (!actual.isDirectory() || (mode !== undefined && (actual.mode & 0o777) !== mode))
      throw new Error('Owned directory facts changed');
  }

  /** Validate the published root pathname and every entry in the existing creation journal. */
  verifyCreated(root: string) {
    this.requireOpen();
    const current = lstatSync(root);
    if (!current.isDirectory() || !sameInode(current, fstatSync(this.root)))
      throw new Error('Owned publication root namespace changed');
    this.verifyDirectory('');
    for (const relative of this.directories.keys()) this.verifyDirectory(relative);
    for (const relative of this.files.keys()) this.verify(relative);
    const members = new Map<string, Set<string>>([['', new Set()]]);
    for (const directory of this.directories.keys()) members.set(directory, new Set());
    for (const relative of [...this.directories.keys(), ...this.files.keys()]) {
      const slash = relative.lastIndexOf('/');
      const parent = slash < 0 ? '' : relative.slice(0, slash);
      const entries = members.get(parent);
      if (entries === undefined) throw new Error('Owned journal parent is absent');
      entries.add(relative.slice(slash + 1));
    }
    for (const [relative, expected] of members) {
      const actual = readdirSync(relative === '' ? root : `${root}/${relative}`).sort();
      if (actual.join('\0') !== [...expected].sort().join('\0'))
        throw new Error('Owned publication contains unconfigured directory entries');
      this.verifyDirectory(relative);
    }
    const final = lstatSync(root);
    if (!final.isDirectory() || !sameInode(final, fstatSync(this.root)))
      throw new Error('Owned publication root namespace changed');
  }

  write(relative: string, content: string | Uint8Array, mode = 0o644) {
    const { parent, name } = this.parent(relative, true);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777)
      throw new Error('Owned file mode must be an explicit permission mode');
    const fd = this.library.symbols.openat(
      parent,
      ptr(name),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    if (fd < 0) throw new Error('Owned publication requires a fresh ordinary output');
    this.descriptors.push(fd);
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    this.files.set(relative, {
      fd,
      parent,
      name,
      identity: fstatSync(fd),
      sha256: digest(bytes),
      size: bytes.byteLength,
      mode,
    });
    writeFileSync(fd, bytes);
    fchmodSync(fd, mode);
    this.verify(relative);
  }

  /** Loan only journal-owned ordinary Files; restore their original held inode in every outcome. */
  withTemporaryContents(
    replacements: readonly { readonly path: string; readonly bytes: Uint8Array }[],
    run: () => void,
  ): void {
    const originals: { file: File; bytes: Buffer }[] = [];
    const temporary: File[] = [];
    const failures: unknown[] = [];
    const paths = new Set<string>();
    const write = (file: File, bytes: Uint8Array, mode: number): void => {
      ftruncateSync(file.fd, bytes.byteLength);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = writeSync(file.fd, bytes, offset, bytes.byteLength - offset, offset);
        if (count === 0) throw new Error('Temporary owned contents write made no progress');
        offset += count;
      }
      fchmodSync(file.fd, mode);
    };
    try {
      for (const replacement of replacements) {
        const file = this.files.get(replacement.path);
        if (file === undefined || file.target !== undefined || paths.has(replacement.path))
          throw new Error('Temporary contents require distinct journal-owned ordinary Files');
        paths.add(replacement.path);
        this.verifyRegularFile(file);
        originals.push({ file, bytes: readBytes(file.fd, file.size) });
        write(file, replacement.bytes, 0o600);
        const projected = {
          ...file,
          size: replacement.bytes.byteLength,
          sha256: digest(replacement.bytes),
          mode: 0o600,
        };
        this.verifyRegularFile(projected);
        temporary.push(projected);
      }
      run();
      for (const file of temporary) this.verifyRegularFile(file);
    } catch (error) {
      failures.push(error);
    }
    for (const { file, bytes } of originals.reverse()) {
      try {
        // The held original fd is the sole write authority, even if its pathname was replaced.
        write(file, bytes, file.mode);
        this.verifyRegularFile(file);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Temporary source restoration failed');
  }

  symlink(relative: string, target: string) {
    const { parent, name } = this.parent(relative, true);
    if (target.length === 0 || target.includes('\0'))
      throw new Error('Owned alias requires a validated target');
    const value = Buffer.from(`${target}\0`);
    if (this.library.symbols.symlinkat(ptr(value), parent, ptr(name)) !== 0)
      throw new Error('Owned alias requires a fresh output');
    // Darwin O_SYMLINK and Linux O_PATH retain the symlink inode itself.
    const flags = process.platform === 'darwin' ? 0x200000 : 0x200000 | constants.O_NOFOLLOW;
    const fd = this.library.symbols.openat(parent, ptr(name), flags, 0);
    if (fd < 0) throw new Error('Owned alias inode could not be retained');
    this.descriptors.push(fd);
    this.files.set(relative, {
      fd,
      parent,
      name,
      identity: fstatSync(fd),
      sha256: digest(Buffer.from(target)),
      size: Buffer.byteLength(target),
      mode: 0o777,
      target,
    });
    this.verify(relative);
  }

  verify(relative: string) {
    this.requireOpen();
    const file = this.files.get(relative);
    if (file === undefined)
      throw new Error('Cannot verify a file outside the owned creation journal');
    if (file.target !== undefined) {
      this.verifyParents(file.parent);
      this.verifyAlias(file);
      return;
    }
    this.verifyRegularFile(file);
  }

  /**
   * Prove the journal in one sweep: every retained directory's entry, the facts of
   * `directories`, the entry and bytes of each of `files`, then every directory's entry again.
   * Each member gets the proof `verifyDirectory` and `verify` give it; its containing
   * directories are proved on both sides of the sweep instead of around every member.
   */
  verifyJournal(directories: Iterable<string>, files: Iterable<string>) {
    this.requireOpen();
    const namespace = () => {
      for (const directory of this.directories.values())
        this.verifyEntry(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
    };
    namespace();
    for (const relative of directories) this.verifyDirectoryFacts(relative);
    for (const relative of files) {
      const file = this.files.get(relative);
      if (file === undefined)
        throw new Error('Cannot verify a file outside the owned creation journal');
      if (file.target !== undefined) {
        this.verifyAlias(file);
        continue;
      }
      this.verifyEntry(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      this.verifyBytes(file);
      this.verifyEntry(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    namespace();
  }

  /** Submit owned bytes and their containing namespace before publication is acknowledged. */
  sync(relative: string) {
    this.requireOpen();
    const file = this.files.get(relative);
    if (file === undefined || file.target !== undefined)
      throw new Error('Sync requires an owned regular file');
    this.verify(relative);
    fsyncSync(file.fd);
    this.verify(relative);
    this.syncParents(file.parent);
    this.verify(relative);
    // Darwin fsync may leave data in the drive cache. Request its stronger flush
    // after every containing directory's metadata has been submitted. This is a
    // native durability request, not proof against a drive that ignores it.
    if (process.platform === 'darwin' && this.library.symbols.fcntl(file.fd, 51, 0) !== 0)
      throw new Error('Owned publication F_FULLFSYNC failed');
    this.verify(relative);
  }

  private syncParents(fd: number) {
    let current = fd;
    while (true) {
      this.verifyParents(current);
      fsyncSync(current);
      this.verifyParents(current);
      if (current === this.root) return;
      const directory = this.directoryDescriptors.get(current);
      if (directory === undefined) throw new Error('Unknown owned directory capability');
      current = directory.parent;
    }
  }

  private verifyRegularFile(file: File) {
    this.verifyParents(file.parent);
    this.verifyEntry(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    this.verifyBytes(file);
    this.verifyParents(file.parent);
    this.verifyEntry(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  }

  private verifyBytes(file: File) {
    const before = fstatSync(file.fd);
    if (!before.isFile() || before.size !== file.size || (before.mode & 0o777) !== file.mode)
      throw new Error('Owned publication file facts changed');
    const content = readBytes(file.fd, file.size);
    const after = fstatSync(file.fd);
    if (
      !sameInode(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      digest(content) !== file.sha256
    )
      throw new Error('Owned publication bytes changed');
  }

  /** Existing inputs remain outside the creation journal and can never be removed by cleanup. */
  readExisting(relative: string): { bytes: Buffer; sha256: string; size: number } {
    this.requireOpen();
    const retained = this.existingFiles.get(relative);
    if (retained !== undefined) {
      this.verifyRegularFile(retained);
      const bytes = readBytes(retained.fd, retained.size);
      if (digest(bytes) !== retained.sha256) throw new Error('Existing input bytes changed');
      this.verifyRegularFile(retained);
      return { bytes, sha256: retained.sha256, size: retained.size };
    }
    const { parent, name } = this.parent(relative, false);
    this.verifyParents(parent);
    const fd = this.library.symbols.openat(
      parent,
      ptr(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    );
    if (fd < 0) throw new Error('Existing input must be an ordinary anchored file');
    this.descriptors.push(fd);
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('Existing input must be an ordinary anchored file');
    const bytes = readBytes(fd, before.size);
    const after = fstatSync(fd);
    if (
      !sameInode(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Existing input changed while being captured');
    const file: File = {
      fd,
      parent,
      name,
      identity: before,
      sha256: digest(bytes),
      size: bytes.length,
      mode: before.mode & 0o777,
    };
    this.existingFiles.set(relative, file);
    this.verifyRegularFile(file);
    return { bytes, sha256: file.sha256, size: file.size };
  }

  verifyExisting(relative: string) {
    this.requireOpen();
    const file = this.existingFiles.get(relative);
    if (file === undefined) throw new Error('Existing input was not captured by this capability');
    this.verifyRegularFile(file);
  }

  private verifyAlias(file: File) {
    const flags = process.platform === 'darwin' ? 0x200000 : 0x200000 | constants.O_NOFOLLOW;
    this.verifyEntry(file, flags);
    const content = Buffer.alloc(file.size + 1);
    const length = Number(
      this.library.symbols.readlinkat(
        file.parent,
        ptr(file.name),
        ptr(content),
        content.byteLength,
      ),
    );
    if (length !== file.size || content.subarray(0, length).toString() !== file.target)
      throw new Error('Owned publication alias target changed');
  }

  removeCreated() {
    this.requireOpen();
    const failures: unknown[] = [];
    // Recover access only through descriptors of directories this capability
    // created; restrictive final modes never justify modifying caller parents.
    for (const directory of this.directories.values()) {
      if (!directory.created) continue;
      try {
        const actual = fstatSync(directory.fd);
        if (!sameInode(actual, directory.identity) || !actual.isDirectory())
          throw new Error('Owned cleanup directory identity changed');
        fchmodSync(directory.fd, (actual.mode & 0o777) | 0o700);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const [relative, file] of [...this.files].reverse()) {
      try {
        this.verifyParents(file.parent);
        this.verifyEntry(
          file,
          file.target === undefined
            ? constants.O_RDONLY | constants.O_NOFOLLOW
            : process.platform === 'darwin'
              ? 0x200000
              : 0x200000 | constants.O_NOFOLLOW,
        );
        if (this.library.symbols.unlinkat(file.parent, ptr(file.name), 0) !== 0)
          throw new Error('Owned file removal failed');
        this.files.delete(relative);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const [relative, directory] of [...this.directories].reverse()) {
      try {
        this.verifyParents(directory.fd);
        if (
          directory.created &&
          this.library.symbols.unlinkat(
            directory.parent,
            ptr(directory.name),
            process.platform === 'darwin' ? 0x80 : 0x200,
          ) !== 0
        )
          throw new Error('Owned directory removal failed');
        this.directories.delete(relative);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length !== 0)
      throw new AggregateError(
        failures,
        `Owned cleanup refused changed entries: ${failures.map(String).join('; ')}`,
      );
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const fd of this.descriptors.reverse()) closeSync(fd);
    this.library.close();
  }
}

export async function withOwnedDirectory<T>(
  root: string,
  use: (directory: OwnedDirectory) => Promise<T>,
): Promise<T> {
  const directory = new OwnedDirectory(root);
  try {
    return await use(directory);
  } finally {
    directory.close();
  }
}

export function openOwnedDirectory(root: string): OwnedDirectory {
  return new OwnedDirectory(root);
}

/** A held ordinary root permits reads and verification only, without directory creation. */
export class ReadOnlyDirectory {
  private readonly capability: OwnedDirectory;

  constructor(root: string) {
    this.capability = new OwnedDirectory(root);
  }

  read(relative: string): { bytes: Buffer; sha256: string; size: number } {
    return this.capability.readExisting(relative);
  }

  verify(relative: string) {
    this.capability.verifyExisting(relative);
  }

  close() {
    this.capability.close();
  }
}

export function openReadOnlyDirectory(root: string): ReadOnlyDirectory {
  return new ReadOnlyDirectory(root);
}
