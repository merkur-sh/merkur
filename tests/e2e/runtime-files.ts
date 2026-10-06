import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIRECTORY = path.join(PROJECT_ROOT, 'data');
const SAFE_DATABASE_NAME = /^merkur-(?:e2e|edge)-[A-Za-z0-9._-]+\.db$/;
/**
 * Default database names embed the owning process id; see the Playwright
 * configs. Matched as a prefix so every sibling a run leaves behind is swept:
 * `.db`, `.db-wal`, and `.db-shm`.
 */
const PID_DATABASE_NAME = /^merkur-(?:e2e|edge|edge-topology)-(\d+)\.db/;

/**
 * Remove databases left behind by runs that died before `globalTeardown` — an
 * interrupted or crashed run, which is the common case while iterating on
 * transport specs. Only databases whose owning process is gone are removed, so
 * a concurrently running suite is never touched. Explicitly named databases
 * (`PW_E2E_DB_PATH`) carry no process id and are left alone.
 */
export function sweepOrphanedE2EDatabases(): void {
  let entries: string[];
  try {
    entries = readdirSync(DATA_DIRECTORY);
  } catch {
    return;
  }

  for (const entry of entries) {
    const ownerPid = PID_DATABASE_NAME.exec(entry)?.[1];
    if (ownerPid === undefined || isProcessAlive(Number(ownerPid))) {
      continue;
    }
    rmSync(path.join(DATA_DIRECTORY, entry), { force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    // Signal 0 performs permission and existence checks without delivering it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return isRecord(error) && error.code === 'EPERM';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function prepareE2EDatabase(databasePath: string): void {
  const resolved = validateE2EDatabasePath(databasePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  removeDatabaseFiles(resolved);
}

export function removeE2EDatabase(databasePath: string): void {
  removeDatabaseFiles(validateE2EDatabasePath(databasePath));
}

function validateE2EDatabasePath(databasePath: string): string {
  const resolved = path.resolve(databasePath);
  const relative = path.relative(DATA_DIRECTORY, resolved);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !SAFE_DATABASE_NAME.test(path.basename(resolved))
  ) {
    throw new Error(
      `Refusing E2E database cleanup outside ${DATA_DIRECTORY} or without a merkur-e2e/edge name: ${resolved}`,
    );
  }
  return resolved;
}

function removeDatabaseFiles(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}
