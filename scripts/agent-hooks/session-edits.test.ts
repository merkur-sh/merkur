import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { editedFiles, parsePorcelainPaths, recordEdits } from './session-edits';

const made: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'session-edits-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('a session reads back the files it edited, once each, in first-edit order', () => {
  const tmp = scratch();
  recordEdits('a', ['/repo/x.ts', '/repo/y.md'], tmp);
  recordEdits('a', ['/repo/x.ts'], tmp);
  recordEdits('b', ['/repo/z.ts'], tmp);
  expect(editedFiles('a', tmp)).toEqual(['/repo/x.ts', '/repo/y.md']);
  expect(editedFiles('b', tmp)).toEqual(['/repo/z.ts']);
});

test('a session that edited nothing, or has an unsafe id, has no files', () => {
  const tmp = scratch();
  expect(editedFiles('fresh', tmp)).toEqual([]);
  recordEdits('../escape', ['/repo/x.ts'], tmp);
  expect(editedFiles('../escape', tmp)).toEqual([]);
});

test('porcelain records give their paths, and a rename skips its origin', () => {
  const output = [' M apps/a.ts', '?? docs/new file.md', 'R  b-new.ts', 'b-old.ts', 'A  c.ts', ''];
  expect(parsePorcelainPaths(output.join('\0'))).toEqual([
    'apps/a.ts',
    'docs/new file.md',
    'b-new.ts',
    'c.ts',
  ]);
  expect(parsePorcelainPaths('')).toEqual([]);
});
