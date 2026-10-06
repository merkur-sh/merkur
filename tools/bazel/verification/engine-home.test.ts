import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { engineHome, holdEngineHome } from './engine-home';

test('each checkout has its own engine home in the user cache', () => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'merkur-engine-home-')));
  try {
    const first = engineHome(parent, {});
    expect(path.isAbsolute(first)).toBe(true);
    expect(first.includes(`${path.sep}merkur-verification${path.sep}`)).toBe(true);
    expect(engineHome(parent, {})).toBe(first);
    expect(engineHome(tmpdir(), {})).not.toBe(first);
    if (process.platform !== 'darwin') {
      expect(engineHome(parent, { XDG_CACHE_HOME: parent }).startsWith(parent)).toBe(true);
      expect(engineHome(parent, { XDG_CACHE_HOME: 'relative' })).toBe(first);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('one live run holds an engine home; a dead holder releases it', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'merkur-engine-home-'));
  try {
    const home = path.join(parent, 'home');
    const release = holdEngineHome(home);
    expect(readFileSync(path.join(home, 'holder'), 'utf8')).toBe(`${process.pid}\n`);
    expect(() => holdEngineHome(home)).toThrow('holds this engine home');
    release();
    const again = holdEngineHome(home);
    again();

    // A holder that no longer exists: the largest process identity is never a live one here.
    writeFileSync(path.join(home, 'holder'), '2147483646\n');
    const taken = holdEngineHome(home);
    expect(readFileSync(path.join(home, 'holder'), 'utf8')).toBe(`${process.pid}\n`);
    taken();
    writeFileSync(path.join(home, 'holder'), 'not a process\n');
    holdEngineHome(home)();
    expect(() => holdEngineHome('relative')).toThrow('absolute');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
