import { expect, test } from 'bun:test';
import { mkdtemp, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { ensureDevelopmentServerEnvironment } from './dev-server-env';

test('setup writes owner-only files and leaves invalid existing identities untouched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'merkur-setup-'));
  const file = path.join(dir, '.env');
  try {
    await Effect.runPromise(ensureDevelopmentServerEnvironment(file, {}));
    const initial = await readFile(file, 'utf8');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await Effect.runPromise(ensureDevelopmentServerEnvironment(file, {}))).added).toEqual(
      [],
    );
    expect(await readFile(file, 'utf8')).toBe(initial);
    const invalid = `${initial}\nOPAQUE_SERVER_SETUP=invalid\n`;
    await writeFile(file, invalid);
    await expect(Effect.runPromise(ensureDevelopmentServerEnvironment(file, {}))).rejects.toThrow(
      'existing identity was preserved',
    );
    expect(await readFile(file, 'utf8')).toBe(invalid);
    await expect(stat(`${file}.lock`)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a held setup lock prevents any replacement', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'merkur-setup-lock-'));
  const file = path.join(dir, '.env');
  const lock = await open(`${file}.lock`, 'wx', 0o600);
  try {
    await writeFile(file, '# preserve this file\n');
    await expect(Effect.runPromise(ensureDevelopmentServerEnvironment(file, {}))).rejects.toThrow(
      'Cannot acquire',
    );
    expect(await readFile(file, 'utf8')).toBe('# preserve this file\n');
  } finally {
    await lock.close();
    await unlink(`${file}.lock`);
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid nonidentity settings fail before writing, even when an override would conceal them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'merkur-setup-validation-'));
  const file = path.join(dir, '.env');
  try {
    const contents = 'PORT=0\n';
    await writeFile(file, contents);
    await expect(
      Effect.runPromise(ensureDevelopmentServerEnvironment(file, { PORT: '3100' })),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(contents);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
