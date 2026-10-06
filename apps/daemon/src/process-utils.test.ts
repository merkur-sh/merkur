import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPositivePidFile } from './process-utils';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0, tempDirectories.length)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('PID file parsing', () => {
  test('accepts one exact positive safe decimal PID', async () => {
    const file = await pidFile('123\n');
    expect(await readPositivePidFile(file)).toBe(123);
  });

  test('rejects partial, signed, zero, padded, fractional, and unsafe PIDs', async () => {
    for (const raw of [
      '123junk',
      '+123',
      '-1',
      '0',
      '00123',
      '1.5',
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(await readPositivePidFile(await pidFile(raw))).toBeNull();
    }
  });
});

async function pidFile(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-pid-test-'));
  tempDirectories.push(directory);
  const file = path.join(directory, 'daemon.pid');
  await writeFile(file, contents);
  return file;
}
