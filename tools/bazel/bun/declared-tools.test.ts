import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';

test('only declared executable tools and the pinned Bun runtime enter test PATH', () => {
  const tool = Bun.spawnSync(['declared-merkur-tool', 'declared-input'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(tool.exitCode).toBe(0);
  expect(new TextDecoder().decode(tool.stderr)).toBe('');
  expect(JSON.parse(new TextDecoder().decode(tool.stdout))).toEqual({
    argument: 'declared-input',
    version: '1.4.2',
  });
  const path = process.env.PATH;
  expect(typeof path).toBe('string');
  if (!path) throw new Error('declared PATH absent');
  const entries = path.split(':');
  expect(entries).toHaveLength(2);
  expect(entries[0]?.endsWith('/declared_tools_test.tools')).toBe(true);
  expect(Bun.which('git')).toBeNull();
  expect(Bun.which('cargo')).toBeNull();
  const runtime = Bun.which('bun');
  expect(typeof runtime).toBe('string');
  if (!runtime) throw new Error('pinned Bun executable absent');
  expect(realpathSync(runtime)).toBe(realpathSync(process.execPath));
});
