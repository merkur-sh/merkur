import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { nativeExitCode } from './native-exit';

type Environment = Readonly<Record<string, string | undefined>>;
type Invocation = (
  argv: string[],
  options: { cwd: string; env: Record<string, string>; stdout: 'inherit'; stderr: 'inherit' },
) => { exitCode: number; signalCode?: string | null };

function requiredFile(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || !path.isAbsolute(value))
    throw new Error(`Declared absolute ${name} File required`);
  const file = realpathSync(value);
  if (!lstatSync(file).isFile()) throw new Error(`${name} must be a regular File`);
  return file;
}

function requireInside(root: string, file: string) {
  const relative = path.relative(root, file);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Owned formatting file escaped the workspace');
}

/** Validate the complete owned-file request before the native formatter can write. */
export function formatFiles(
  files: readonly string[],
  environment: Environment = process.env,
  invoke: Invocation = (argv, options) => Bun.spawnSync(argv, options),
): number {
  const workspace = environment.BUILD_WORKSPACE_DIRECTORY;
  if (workspace === undefined || !path.isAbsolute(workspace))
    throw new Error('Bazel BUILD_WORKSPACE_DIRECTORY required');
  const root = realpathSync(workspace);
  if (!lstatSync(root).isDirectory()) throw new Error('Workspace must be an ordinary directory');
  if (files.length === 0) throw new Error('Name at least one owned file');
  const runfiles = environment.MERKUR_BAZEL_RUNFILES_ROOT;
  if (
    runfiles === undefined ||
    !path.isAbsolute(runfiles) ||
    !lstatSync(realpathSync(runfiles)).isDirectory()
  )
    throw new Error('Declared Bazel runfiles directory required');
  const biome = requiredFile(environment, 'MERKUR_FORMAT_BIOME');
  accessSync(biome, constants.X_OK);
  const config = requiredFile(environment, 'MERKUR_FORMAT_CONFIG');
  const currentConfig = path.join(root, 'biome.json');
  if (!lstatSync(currentConfig).isFile())
    throw new Error('Workspace Biome config must be ordinary');
  if (!readFileSync(config).equals(readFileSync(currentConfig)))
    throw new Error('Workspace Biome configuration differs from the declared configuration');
  const selected = new Set<string>();
  for (const file of files) {
    if (file.length === 0 || file.startsWith('-') || file.includes('\0'))
      throw new Error('Only explicit owned file paths are accepted');
    const requested = path.resolve(root, file);
    requireInside(root, requested);
    const actual = realpathSync(requested);
    requireInside(root, actual);
    const identity = lstatSync(requested);
    if (!identity.isFile()) throw new Error('Owned formatting inputs must be regular files');
    if (identity.nlink !== 1) throw new Error('Owned formatting inputs must have a single link');
    if (selected.has(actual)) throw new Error('Duplicate owned formatting file');
    selected.add(actual);
  }
  const result = invoke(
    [biome, 'format', '--write', `--config-path=${currentConfig}`, ...selected],
    {
      cwd: root,
      env: { PATH: '', RUNFILES_DIR: runfiles },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  return nativeExitCode(result, 'Formatter');
}

if (import.meta.main) process.exitCode = formatFiles(process.argv.slice(2));
