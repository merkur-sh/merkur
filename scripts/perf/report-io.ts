import { mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reject every existing alias of the baseline before any workload executes.
 * realpath catches symlinks (including symlinked parent directories), while
 * device/inode identity catches hard links.
 */
export async function assertDistinctReportFiles(
  baselinePath: string,
  outputPath: string,
): Promise<void> {
  const [baselineCanonical, outputCanonical] = await Promise.all([
    canonicalPath(baselinePath),
    canonicalPath(outputPath),
  ]);
  if (baselineCanonical === outputCanonical) {
    throw new Error('--baseline and --output must identify different files');
  }

  const [baselineIdentity, outputIdentity] = await Promise.all([
    fileIdentity(baselinePath),
    fileIdentity(outputPath),
  ]);
  if (
    baselineIdentity !== null &&
    outputIdentity !== null &&
    baselineIdentity.device === outputIdentity.device &&
    baselineIdentity.inode === outputIdentity.inode
  ) {
    throw new Error('--baseline and --output must not be hard-link aliases');
  }
}

/** Write beside the destination and rename only after data and metadata are durable. */
export async function atomicWriteText(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    temporaryExists = false;
    await syncDirectory(directory);
  } finally {
    if (temporaryExists) await unlinkIfPresent(temporaryPath);
  }
}

/**
 * Remove deterministic Bun profiler names before capture. A successful
 * profiler command can therefore never "validate" an artifact from an older
 * run.
 */
export async function prepareProfilerArtifacts(paths: readonly string[]): Promise<number> {
  for (const filePath of paths) await unlinkIfPresent(filePath);
  return Date.now();
}

export async function validateProfilerArtifacts(
  paths: readonly string[],
  captureStartedAtMs: number,
): Promise<void> {
  for (const filePath of paths) {
    const metadata = await stat(filePath).catch((error: unknown) => {
      throw new Error(`profiler did not write ${filePath}: ${errorMessage(error)}`);
    });
    if (!metadata.isFile() || metadata.size <= 0) {
      throw new Error(`profiler artifact is empty or not a regular file: ${filePath}`);
    }
    // Some filesystems expose one-second timestamp precision. Removal before
    // capture is the primary freshness guarantee; this rejects clearly
    // backdated replacement files without making coarse filesystems flaky.
    if (metadata.mtimeMs < captureStartedAtMs - 2_000) {
      throw new Error(`profiler artifact is stale: ${filePath}`);
    }
    if (filePath.endsWith('.cpuprofile') || filePath.endsWith('.heapsnapshot')) {
      const value: unknown = await Bun.file(filePath)
        .json()
        .catch((error: unknown) => {
          throw new Error(
            `profiler artifact is not valid JSON (${filePath}): ${errorMessage(error)}`,
          );
        });
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`profiler artifact has an invalid JSON root: ${filePath}`);
      }
    }
  }
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const directory = path.dirname(filePath);
  const canonicalDirectory = await realpath(directory).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    return path.resolve(directory);
  });
  return path.join(canonicalDirectory, path.basename(filePath));
}

async function fileIdentity(
  filePath: string,
): Promise<{ readonly device: number; readonly inode: number } | null> {
  try {
    const metadata = await stat(filePath);
    return { device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Directory fsync is supported on Unix. Windows may reject opening a
  // directory; the atomic rename has still completed there.
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
