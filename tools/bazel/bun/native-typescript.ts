import path from 'node:path';

const executable = process.env.MERKUR_NATIVE_TYPESCRIPT;
const runfiles = process.env.MERKUR_BAZEL_RUNFILES_ROOT;
if (
  executable === undefined ||
  runfiles === undefined ||
  !path.isAbsolute(executable) ||
  !path.isAbsolute(runfiles)
) {
  throw new Error('Native TypeScript requires its declared executable and engine runfiles');
}
const child = Bun.spawnSync([executable, ...process.argv.slice(2)], {
  env: { ...process.env, RUNFILES_DIR: runfiles },
  stdout: 'inherit',
  stderr: 'inherit',
});
if (child.signalCode !== undefined && child.signalCode !== null) {
  throw new Error(`Native TypeScript terminated: ${child.signalCode}`);
}
process.exit(child.exitCode);
