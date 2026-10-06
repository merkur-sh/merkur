import { expect, test } from 'bun:test';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

test('ordinary test sources cannot read undeclared files from an earlier Bazel build', () => {
  const scratch = process.env.TEST_TMPDIR;
  if (scratch === undefined) throw new Error('isolated Bazel test scratch absent');
  expect(import.meta.path.startsWith(realpathSync(scratch) + path.sep)).toBe(true);
  expect(lstatSync(import.meta.path).isSymbolicLink()).toBe(false);
  expect(readFileSync(new URL('./declared-marker.txt', import.meta.url), 'utf8')).toBe(
    'declared-source-visible\n',
  );
  expect(() => readFileSync(new URL('./ambient-marker.txt', import.meta.url), 'utf8')).toThrow(
    'ENOENT',
  );
});
