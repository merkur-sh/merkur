import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionStatePath } from './hook-io';

/**
 * The files one session has edited, so the Stop hook can speak about that session's work alone.
 *
 * Sessions share the checkout: the working tree's diff holds every session's uncommitted edits,
 * and only the edit events say whose each one is. PostToolUse appends the absolute path of every
 * file an edit tool call touched (Claude's `Edit|Write|MultiEdit`, Codex's `apply_patch`), one
 * per line; Stop reads the set back. An edit made by a shell command raises no edit event and is
 * not in the set.
 */

const EDITED_FILES = 'edited-files';

export function recordEdits(
  sessionId: string,
  files: readonly string[],
  tmpdir: string = os.tmpdir(),
): void {
  const record = sessionStatePath(EDITED_FILES, sessionId, tmpdir);
  if (record === null || files.length === 0) return;
  mkdirSync(path.dirname(record), { recursive: true });
  appendFileSync(record, `${files.join('\n')}\n`);
}

/** Every file the session has edited, once each, in the order first edited. */
export function editedFiles(sessionId: string, tmpdir: string = os.tmpdir()): string[] {
  const record = sessionStatePath(EDITED_FILES, sessionId, tmpdir);
  if (record === null || !existsSync(record)) return [];
  const lines = readFileSync(record, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  return [...new Set(lines)];
}

/**
 * The repo-relative paths that `git status --porcelain=v1 -z` lists as changed. A rename or copy
 * record carries its origin as the next field, which is skipped.
 */
export function parsePorcelainPaths(output: string): string[] {
  const fields = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? '';
    if (field.length < 4) continue;
    paths.push(field.slice(3));
    if (field[0] === 'R' || field[0] === 'C') index += 1;
  }
  return paths;
}

/** The edited files under `root`, repo-relative, that still differ from `HEAD` there. */
export function uncommittedEdits(root: string, files: readonly string[]): string[] {
  const inside: string[] = [];
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative !== '' && !relative.startsWith('../') && !path.isAbsolute(relative)) {
      inside.push(relative);
    }
  }
  if (inside.length === 0) return [];
  const status = Bun.spawnSync(
    ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...inside],
    { cwd: root, stdout: 'pipe', stderr: 'ignore', timeout: 5_000 },
  );
  if (!status.success) return [];
  return parsePorcelainPaths(status.stdout.toString());
}
