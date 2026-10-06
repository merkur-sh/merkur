import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const declaredScratch = process.env.MERKUR_BAZEL_SCRATCH_ROOT;
if (declaredScratch !== undefined && !path.isAbsolute(declaredScratch)) {
  throw new Error('MERKUR_BAZEL_SCRATCH_ROOT must be absolute');
}
const STORE =
  declaredScratch === undefined
    ? path.resolve(import.meta.dir, '..', 'test-results', 'test-executables')
    : path.join(declaredScratch, 'test-executables');
const MODE = 0o555;

function stored(file: string, bytes: Uint8Array): boolean {
  try {
    return (statSync(file).mode & 0o777) === MODE && readFileSync(file).equals(bytes);
  } catch {
    return false;
  }
}

/**
 * Put a test's stand-in executable at `directory/name` and return its path.
 *
 * macOS assesses every new executable file the first time it runs, in one system daemon that
 * serves every process: 300-560 ms per file measured here. A stub written fresh for each test
 * cost more than the test did, and parallel test workers queued behind one another. So the bytes
 * are written once, read-only and named by their SHA-256, under the runner-owned scratch root
 * (or `test-results/test-executables` for source runs),
 * and each call links them into the caller's own directory: a test keeps a private PATH entry
 * and runs exactly the bytes it asked for, while the system has already seen the file. A write
 * through the link fails rather than changing a stub another test or a later run executes, and
 * an entry whose bytes or mode no longer match its name is replaced.
 */
export function linkTestExecutable(directory: string, name: string, source: string): string {
  const bytes = Buffer.from(source);
  const file = path.join(STORE, new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
  if (!stored(file, bytes)) {
    mkdirSync(STORE, { recursive: true });
    // Staged then renamed, so a concurrent run sees either the old entry or the whole new one.
    const staging = `${file}.${process.pid}.${crypto.randomUUID()}`;
    writeFileSync(staging, bytes);
    chmodSync(staging, MODE);
    renameSync(staging, file);
  }
  const link = path.join(directory, name);
  symlinkSync(file, link);
  return link;
}
