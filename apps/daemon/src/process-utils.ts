import { readFile } from 'node:fs/promises';

export function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

export function isFileExistsError(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST');
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, 'EPERM');
  }
}

export async function readPositivePidFile(filePath: string): Promise<number | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const value = raw.trim();
    if (!/^[1-9]\d*$/.test(value)) return null;
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? pid : null;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
