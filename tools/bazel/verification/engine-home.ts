import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where an unforced run keeps its engine between runs: the output base, the server's home and
 * the stable source copy, one directory per checkout in the user's cache. A forced, placed or
 * artifact-producing run has no home; its engine is private to the run.
 */
export function engineHome(root: string, environment: NodeJS.ProcessEnv = process.env): string {
  const home = os.homedir();
  const configured = environment.XDG_CACHE_HOME;
  const caches =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Caches')
      : configured !== undefined && path.isAbsolute(configured)
        ? configured
        : path.join(home, '.cache');
  if (!path.isAbsolute(caches)) throw new Error('Engine home requires an absolute user cache');
  const checkout = createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16);
  return path.join(caches, 'merkur-verification', checkout);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * One run at a time owns an engine home: its source copy is replaced in place. The holder is a
 * process identity, so a run that died releases the home to the next one.
 */
export function holdEngineHome(directory: string): () => void {
  if (!path.isAbsolute(directory)) throw new Error('Engine home requires an absolute directory');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'holder');
  for (;;) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    let holder: number;
    try {
      holder = Number(readFileSync(lock, 'utf8').trim());
    } catch (error) {
      // The holder released between the two calls.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (Number.isSafeInteger(holder) && holder > 0 && alive(holder))
      throw new Error(`Another verification run (process ${holder}) holds this engine home`);
    rmSync(lock, { force: true });
  }
  return () => {
    if (readFileSync(lock, 'utf8').trim() === String(process.pid)) rmSync(lock, { force: true });
  };
}
