import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** The installed sibling, or the same release directory in a source checkout. */
async function tuiExecutable(): Promise<string> {
  const source = path.resolve(import.meta.dir, '../index.ts');
  return existsSync(source)
    ? path.resolve(import.meta.dir, '../../dist/merkur-tui')
    : path.join(path.dirname(await realpath(process.execPath)), 'merkur-tui');
}

/** The native client owns this process and its inherited controlling TTY. */
export async function runTuiCommand(args: readonly string[]): Promise<number> {
  const executable = await tuiExecutable();
  if (process.execve === undefined) {
    throw new Error('this runtime cannot replace its process image');
  }
  return process.execve(executable, [executable, ...args], process.env);
}
