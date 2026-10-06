import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('configured Darwin consumer flags keep original compiler and SDK Files together', () => {
  const report = process.env.MERKUR_DARWIN_CC_TEST_SNAPSHOT;
  if (report === undefined || !path.isAbsolute(report))
    throw new Error('Darwin provider controls require the actual configured analysis output');
  const result: unknown = JSON.parse(readFileSync(report, 'utf8'));
  if (typeof result !== 'object' || result === null)
    throw new Error('Darwin provider analysis output must be an object');
  const value = result as Record<string, unknown>;
  if (
    typeof value.sysroot !== 'string' ||
    !Array.isArray(value.all_files) ||
    !Array.isArray(value.compile_flags) ||
    !Array.isArray(value.link_flags) ||
    !Array.isArray(value.archive_flags) ||
    typeof value.tools !== 'object' ||
    value.tools === null ||
    typeof value.environment !== 'object' ||
    value.environment === null
  )
    throw new Error('Incomplete actual configured Darwin provider output');
  const tools = value.tools as Record<string, unknown>;
  const environment = value.environment as Record<string, unknown>;
  for (const [action, tool] of Object.entries(tools)) {
    expect([
      'c-compile',
      'c++-compile',
      'c++-link-executable',
      'c++-link-static-library',
    ]).toContain(action);
    expect(typeof tool).toBe('string');
    expect(value.all_files).toContain(tool);
  }
  expect(Object.keys(tools)).toHaveLength(4);
  const target = value.compile_flags.find(
    (flag: unknown) => typeof flag === 'string' && flag.startsWith('--target='),
  );
  expect(target).toMatch(/^--target=(arm64|x86_64)-apple-macos[0-9.]+$/);
  expect(value.link_flags).toContain(target);
  expect(value.compile_flags).toContain('-nostdinc');
  expect(value.compile_flags).toContain('-nostdinc++');
  expect(value.compile_flags).toContain(value.sysroot);
  expect(environment.SDKROOT).toBe(value.sysroot);
  expect(environment.ZERO_AR_DATE).toBe('1');
  expect(value.archive_flags).toEqual(['rcs', 'unit.a']);
  expect(value.link_flags).toContain('-o');
  expect(value.link_flags).toContain('unit');
});
