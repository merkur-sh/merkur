import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

function dispatch(environment: NodeJS.ProcessEnv) {
  return Bun.spawnSync(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      '--config=tools/bazel/bun/empty-bunfig.toml',
      new URL('./native-typescript.ts', import.meta.url).pathname,
      '--version',
    ],
    { env: environment, stdout: 'pipe', stderr: 'pipe' },
  );
}

test('native TypeScript executes the configured locked tool', () => {
  const child = dispatch(process.env);
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe('Version 7.0.2');
});

test('native TypeScript refuses PATH lookup and missing declared inputs', () => {
  const scratch = process.env.TEST_TMPDIR;
  const executable = process.env.MERKUR_NATIVE_TYPESCRIPT;
  const runfiles = process.env.MERKUR_BAZEL_RUNFILES_ROOT;
  if (scratch === undefined || executable === undefined || runfiles === undefined) {
    throw new Error('native admission control requires its engine tools and scratch');
  }
  const emptyRunfiles = path.join(scratch, 'empty-native-runfiles');
  mkdirSync(emptyRunfiles);
  for (const environment of [
    { MERKUR_NATIVE_TYPESCRIPT: 'tsc' },
    { MERKUR_BAZEL_RUNFILES_ROOT: '.' },
    { MERKUR_NATIVE_TYPESCRIPT: path.join(scratch, 'missing-native-compiler') },
    { MERKUR_BAZEL_RUNFILES_ROOT: emptyRunfiles },
  ]) {
    const child = dispatch({ ...process.env, ...environment });
    expect(child.exitCode).not.toBe(0);
  }
});
