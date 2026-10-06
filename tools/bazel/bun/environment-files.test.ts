import { expect, test } from 'bun:test';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { declaredEnvironmentFiles } from './environment-files';

test('the engine resolves the exact declared File before evaluating test imports', () => {
  const file = process.env.MERKUR_CONTEXT_TEST_FILE;
  if (file === undefined) throw new Error('Missing declared context File');
  expect(path.isAbsolute(file)).toBe(true);
  expect(file).toBe(realpathSync(file));
  expect(readFileSync(file, 'utf8')).toBe(
    readFileSync(new URL('./declared-marker.txt', import.meta.url), 'utf8'),
  );
});

test('environment File mapping rejects escaped identities, directories and reserved variables', () => {
  const root = process.env.MERKUR_BAZEL_RUNFILES_ROOT;
  if (root === undefined) throw new Error('Missing engine-owned runfiles');
  for (const mapping of [
    { MERKUR_CONTEXT_TEST_FILE: '../ambient' },
    { MERKUR_CONTEXT_TEST_FILE: '/ambient' },
    { MERKUR_CONTEXT_TEST_FILE: '_main' },
    { PATH: '_main/tools/bazel/bun/declared-marker.txt' },
    { 'MALFORMED;CODE': '_main/tools/bazel/bun/declared-marker.txt' },
    { MERKUR_BAZEL_RUNFILES_ROOT: '_main/tools/bazel/bun/declared-marker.txt' },
  ])
    expect(() => declaredEnvironmentFiles(mapping, root)).toThrow();
});
